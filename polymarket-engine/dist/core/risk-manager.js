"use strict";
// ============================================================================
// Polymarket V11 Strategy Engine - Risk Manager
// ============================================================================
// Stop-loss 15%, Take-profit 40%, Rate limiting, Anti-manipulation
Object.defineProperty(exports, "__esModule", { value: true });
exports.RiskManager = void 0;
const logger_1 = require("../utils/logger");
class RiskManager {
    config;
    rateLimit;
    manipulationPauses; // conditionId -> pausedUntil timestamp
    priceHistory; // conditionId -> recent prices for volatility calc
    dailyPnl;
    dailyResetTime;
    constructor(config) {
        this.config = config;
        this.rateLimit = {
            hourlyTrades: 0,
            hourlyResetTime: Date.now() + 3600000,
            dailyPnl: 0,
            dailyResetTime: this.getNextDayStart(),
        };
        this.manipulationPauses = new Map();
        this.priceHistory = new Map();
        this.dailyPnl = 0;
        this.dailyResetTime = this.getNextDayStart();
    }
    getNextDayStart() {
        const now = new Date();
        const tomorrow = new Date(now);
        tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
        tomorrow.setUTCHours(0, 0, 0, 0);
        return tomorrow.getTime();
    }
    /**
     * Check stop-loss: 15% loss triggers exit
     */
    shouldStopLoss(position) {
        const lossPercent = position.pnlPercent;
        if (lossPercent <= -this.config.stopLossPercent) {
            logger_1.logger.warn('Stop-loss triggered', {
                conditionId: position.conditionId,
                pnlPercent: lossPercent.toFixed(2),
                threshold: -this.config.stopLossPercent,
            });
            return true;
        }
        return false;
    }
    /**
     * Check take-profit: 40% gain triggers exit
     */
    shouldTakeProfit(position) {
        const gainPercent = position.pnlPercent;
        if (gainPercent >= this.config.takeProfitPercent) {
            logger_1.logger.info('Take-profit triggered', {
                conditionId: position.conditionId,
                pnlPercent: gainPercent.toFixed(2),
                threshold: this.config.takeProfitPercent,
            });
            return true;
        }
        return false;
    }
    /**
     * Check rate limit: max 2 trades per hour
     */
    canTrade() {
        const now = Date.now();
        // Reset hourly counter
        if (now >= this.rateLimit.hourlyResetTime) {
            this.rateLimit.hourlyTrades = 0;
            this.rateLimit.hourlyResetTime = now + 3600000;
        }
        // Reset daily PnL
        if (now >= this.dailyResetTime) {
            this.dailyPnl = 0;
            this.dailyResetTime = this.getNextDayStart();
        }
        // Check hourly limit
        if (this.rateLimit.hourlyTrades >= this.config.maxTradesPerHour) {
            const waitMin = Math.ceil((this.rateLimit.hourlyResetTime - now) / 60000);
            return {
                allowed: false,
                reason: `Hourly limit reached (${this.rateLimit.hourlyTrades}/${this.config.maxTradesPerHour}). Reset in ${waitMin}min`,
            };
        }
        // Check daily loss limit
        if (this.dailyPnl <= -this.config.maxDailyLossUsd) {
            const waitHours = ((this.dailyResetTime - now) / 3600000).toFixed(1);
            return {
                allowed: false,
                reason: `Daily loss limit reached ($${this.dailyPnl.toFixed(2)}/-$${this.config.maxDailyLossUsd}). Reset in ${waitHours}h`,
            };
        }
        return { allowed: true, reason: 'OK' };
    }
    /**
     * Record a trade for rate limiting
     */
    recordTrade(pnl) {
        this.rateLimit.hourlyTrades++;
        this.dailyPnl += pnl;
        logger_1.logger.info('Trade recorded for rate limit', {
            hourlyTrades: this.rateLimit.hourlyTrades,
            dailyPnl: this.dailyPnl.toFixed(2),
        });
    }
    /**
     * Anti-manipulation: Check for 20%+ price volatility
     * If detected, pause trading on that market for 60 minutes
     */
    checkManipulation(conditionId, currentPrice) {
        const now = Date.now();
        // Check if already paused
        const pausedUntil = this.manipulationPauses.get(conditionId);
        if (pausedUntil && now < pausedUntil) {
            return {
                isManipulation: true,
                volatilityPercent: 0,
                priceChangePercent: 0,
                pausedUntil,
                reason: `Market paused until ${new Date(pausedUntil).toISOString()}`,
            };
        }
        // Clean expired pauses
        if (pausedUntil && now >= pausedUntil) {
            this.manipulationPauses.delete(conditionId);
        }
        // Track price history
        if (!this.priceHistory.has(conditionId)) {
            this.priceHistory.set(conditionId, []);
        }
        const prices = this.priceHistory.get(conditionId);
        prices.push(currentPrice);
        // Keep last 30 price points
        if (prices.length > 30) {
            prices.shift();
        }
        // Need at least 5 data points to calculate volatility
        if (prices.length < 5) {
            return {
                isManipulation: false,
                volatilityPercent: 0,
                priceChangePercent: 0,
                pausedUntil: null,
                reason: 'Insufficient price data',
            };
        }
        // Calculate volatility (standard deviation of returns)
        const returns = [];
        for (let i = 1; i < prices.length; i++) {
            if (prices[i - 1] > 0) {
                returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
            }
        }
        if (returns.length === 0) {
            return {
                isManipulation: false,
                volatilityPercent: 0,
                priceChangePercent: 0,
                pausedUntil: null,
                reason: 'No valid returns',
            };
        }
        const meanReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
        const variance = returns.reduce((a, b) => a + (b - meanReturn) ** 2, 0) / returns.length;
        const volatility = Math.sqrt(variance) * 100;
        // Calculate max price change
        const firstPrice = prices[0];
        const priceChangePercent = firstPrice > 0
            ? Math.abs((currentPrice - firstPrice) / firstPrice) * 100
            : 0;
        // Check threshold
        const maxVolatility = Math.max(volatility, priceChangePercent);
        if (maxVolatility >= this.config.manipulationVolatilityThreshold) {
            const pauseUntil = now + this.config.manipulationPauseMinutes * 60000;
            this.manipulationPauses.set(conditionId, pauseUntil);
            logger_1.logger.warn('Manipulation detected - pausing market', {
                conditionId,
                volatility: volatility.toFixed(2),
                priceChange: priceChangePercent.toFixed(2),
                threshold: this.config.manipulationVolatilityThreshold,
                pausedUntil: new Date(pauseUntil).toISOString(),
            });
            return {
                isManipulation: true,
                volatilityPercent: volatility,
                priceChangePercent,
                pausedUntil: pauseUntil,
                reason: `Volatility ${volatility.toFixed(2)}% or price change ${priceChangePercent.toFixed(2)}% exceeds threshold ${this.config.manipulationVolatilityThreshold}%`,
            };
        }
        return {
            isManipulation: false,
            volatilityPercent: volatility,
            priceChangePercent,
            pausedUntil: null,
            reason: 'OK',
        };
    }
    /**
     * Calculate position size with all risk constraints
     */
    calculatePositionSize(walletBalance, kellySize, existingExposure) {
        // Half-Kelly position sizing
        const kellyAmount = walletBalance * kellySize;
        // Cap at maxPositionPercent
        const maxPositionAmount = walletBalance * (this.config.maxPositionPercent / 100);
        // Deduct existing exposure
        const availableAmount = Math.max(0, maxPositionAmount - existingExposure);
        // Take the minimum of all constraints
        const positionSize = Math.min(kellyAmount, maxPositionAmount, availableAmount);
        return Math.max(0, positionSize);
    }
    /**
     * Get current risk state summary
     */
    getRiskState() {
        const now = Date.now();
        // Clean expired pauses
        for (const [key, until] of this.manipulationPauses) {
            if (now >= until) {
                this.manipulationPauses.delete(key);
            }
        }
        return {
            hourlyTrades: this.rateLimit.hourlyTrades,
            hourlyLimit: this.config.maxTradesPerHour,
            dailyPnl: this.dailyPnl,
            dailyLossLimit: this.config.maxDailyLossUsd,
            pausedMarkets: this.manipulationPauses.size,
        };
    }
}
exports.RiskManager = RiskManager;
