// ============================================================================
// Polymarket V11 Strategy Engine - Polymarket Client
// ============================================================================
// API client for Polymarket CLOB (Central Limit Order Book)

import axios, { AxiosInstance } from 'axios';
import { ethers } from 'ethers';
import { StrategyConfig } from '../core/config';
import { Market, OrderBook, OrderResult, WalletBalance } from '../core/types';
import { logger } from '../utils/logger';

export class PolymarketClient {
  private config: StrategyConfig;
  private httpClient: AxiosInstance;
  private wsConnection: any = null;

  constructor(config: StrategyConfig) {
    this.config = config;
    this.httpClient = axios.create({
      baseURL: config.polymarketApiUrl,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  // ---- Markets ----

  /**
   * Get all active markets
   */
  async getMarkets(params?: {
    active?: boolean;
    closed?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<Market[]> {
    try {
      const response = await this.httpClient.get('/markets', {
        params: {
          active: params?.active ?? true,
          closed: params?.closed ?? false,
          limit: params?.limit ?? 100,
          offset: params?.offset ?? 0,
        },
      });

      // Handle various Polymarket API response formats
      let markets: Market[] = [];
      if (Array.isArray(response.data)) {
        markets = response.data;
      } else if (response.data && Array.isArray(response.data.data)) {
        markets = response.data.data;
      } else if (response.data && typeof response.data === 'object') {
        // Try to find an array property in the response
        const keys = Object.keys(response.data);
        for (const key of keys) {
          if (Array.isArray(response.data[key])) {
            markets = response.data[key];
            break;
          }
        }
      }
      logger.info('Fetched markets', { count: markets.length });
      return markets;
    } catch (error: any) {
      logger.error('Failed to fetch markets', { error: error.message });
      return [];
    }
  }

  /**
   * Get a specific market by condition ID
   */
  async getMarket(conditionId: string): Promise<Market | null> {
    try {
      const response = await this.httpClient.get(`/markets/${conditionId}`);
      return response.data as Market;
    } catch (error: any) {
      logger.error('Failed to fetch market', { conditionId, error: error.message });
      return null;
    }
  }

  /**
   * Search markets by keyword
   */
  async searchMarkets(query: string): Promise<Market[]> {
    try {
      const response = await this.httpClient.get('/markets', {
        params: { query, active: true, closed: false },
      });
      return response.data as Market[];
    } catch (error: any) {
      logger.error('Failed to search markets', { query, error: error.message });
      return [];
    }
  }

  // ---- Order Book ----

  /**
   * Get order book for a token
   */
  async getOrderBook(tokenId: string): Promise<OrderBook> {
    try {
      const response = await this.httpClient.get('/book', {
        params: { token_id: tokenId },
      });
      const data = response.data;

      return {
        tokenId,
        bids: (data.bids || []).map((b: any) => ({
          price: parseFloat(b.price),
          size: parseFloat(b.size),
        })),
        asks: (data.asks || []).map((a: any) => ({
          price: parseFloat(a.price),
          size: parseFloat(a.size),
        })),
        hash: data.hash || '',
        timestamp: Date.now(),
      };
    } catch (error: any) {
      logger.error('Failed to fetch order book', { tokenId, error: error.message });
      return { tokenId, bids: [], asks: [], hash: '', timestamp: Date.now() };
    }
  }

  // ---- Trading ----

  /**
   * Place a limit order
   */
  async placeOrder(params: {
    tokenId: string;
    side: 'BUY' | 'SELL';
    price: number;
    size: number;
  }): Promise<OrderResult> {
    try {
      logger.info('Placing order', params);

      const orderPayload = {
        tokenID: params.tokenId,
        price: params.price,
        size: params.size,
        side: params.side,
        feeRateBps: 0,
        nonce: Date.now(),
      };

      const response = await this.httpClient.post('/order', orderPayload, {
        headers: this.getAuthHeaders(),
      });

      const result = response.data;
      logger.info('Order placed', { orderId: result.orderID });

      return {
        success: true,
        orderId: result.orderID,
        transactionHash: result.transactionHash,
      };
    } catch (error: any) {
      logger.error('Failed to place order', { params, error: error.message });
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Cancel an order
   */
  async cancelOrder(orderId: string): Promise<OrderResult> {
    try {
      const response = await this.httpClient.delete(`/order/${orderId}`, {
        headers: this.getAuthHeaders(),
      });
      return { success: true, orderId };
    } catch (error: any) {
      logger.error('Failed to cancel order', { orderId, error: error.message });
      return { success: false, error: error.message };
    }
  }

  // ---- Wallet ----

  /**
   * Get wallet balance (USDC on Polygon)
   */
  async getWalletBalance(): Promise<WalletBalance> {
    try {
      const provider = new ethers.JsonRpcProvider(this.config.polygonRpcUrl);

      const wallet = this.config.tradingWallet;

      // POL balance
      const polBalance = await provider.getBalance(wallet);
      const pol = parseFloat(ethers.formatEther(polBalance));

      // USDC.e (bridged) balance
      const usdc_e = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
      const erc20Abi = ['function balanceOf(address) view returns (uint256)'];
      const usdcEContract = new ethers.Contract(usdc_e, erc20Abi, provider);
      const usdcEBalance = await usdcEContract.balanceOf(wallet);
      const usdc = parseFloat(ethers.formatUnits(usdcEBalance, 6));

      // USDC (native) balance
      const usdc_native = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
      const usdcNativeContract = new ethers.Contract(usdc_native, erc20Abi, provider);
      const usdcNativeBalance = await usdcNativeContract.balanceOf(wallet);
      const usdcNative = parseFloat(ethers.formatUnits(usdcNativeBalance, 6));

      return {
        pol,
        usdc,
        usdcNative,
        totalUsd: usdc + usdcNative,
      };
    } catch (error: any) {
      logger.error('Failed to get wallet balance', { error: error.message });
      return { pol: 0, usdc: 0, usdcNative: 0, totalUsd: 0 };
    }
  }

  // ---- Profit Recovery ----

  /**
   * Transfer profits to recovery wallet
   */
  async recoverProfits(amountUsdc: number): Promise<OrderResult> {
    try {
      const provider = new ethers.JsonRpcProvider(this.config.polygonRpcUrl);
      const signer = new ethers.Wallet(this.config.privateKey, provider);

      const usdc_e = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
      const erc20Abi = ['function transfer(address to, uint256 amount) returns (bool)'];
      const usdcContract = new ethers.Contract(usdc_e, erc20Abi, signer);

      const amount = ethers.parseUnits(amountUsdc.toFixed(6), 6);
      const tx = await usdcContract.transfer(this.config.profitRecoveryWallet, amount);
      const receipt = await tx.wait();

      logger.info('Profit recovered', {
        amount: amountUsdc,
        to: this.config.profitRecoveryWallet,
        txHash: receipt?.hash || tx.hash,
      });

      return { success: true, transactionHash: receipt?.hash || tx.hash };
    } catch (error: any) {
      logger.error('Failed to recover profits', { error: error.message });
      return { success: false, error: error.message };
    }
  }

  // ---- Auth ----

  private getAuthHeaders(): Record<string, string> {
    const timestamp = Date.now().toString();
    const nonce = Math.random().toString(36).substring(2);

    // Build L2 API auth headers per Polymarket CLOB documentation
    // POLY-SIGNATURE is an EIP-712 signature of the request
    const headers: Record<string, string> = {
      'POLY-ADDRESS': this.config.tradingWallet,
      'POLY-API-KEY': this.config.polymarketApiKey,
      'POLY-TIMESTAMP': timestamp,
      'POLY-NONCE': nonce,
    };

    // Only compute signature if we have the private key
    if (this.config.privateKey) {
      try {
        // Create EIP-712 typed data signature for CLOB authentication
        // In production, this should use the proper @polymarket/order-utils signing
        const message = `${this.config.polymarketApiKey}${timestamp}${nonce}`;
        const provider = new ethers.JsonRpcProvider(this.config.polygonRpcUrl);
        const signer = new ethers.Wallet(this.config.privateKey, provider);
        // Note: For full CLOB auth, use @polymarket/order-utils createApiKeySignature
        // This is a simplified placeholder
        headers['POLY-SIGNATURE'] = ''; // Will be populated by order-utils in production
      } catch {
        headers['POLY-SIGNATURE'] = '';
      }
    }

    return headers;
  }

  // ---- WebSocket ----

  /**
   * Subscribe to order book updates via WebSocket
   */
  async subscribeOrderBook(
    tokenId: string,
    callback: (book: OrderBook) => void
  ): Promise<void> {
    try {
      let WS: any;
      try {
        WS = require('ws');
      } catch {
        logger.warn('ws module not available, skipping WebSocket subscription');
        return;
      }
      const ws = new WS(this.config.polymarketWsUrl);

      ws.on('open', () => {
        logger.info('WebSocket connected', { tokenId });
        ws.send(JSON.stringify({
          auth: {
            apiKey: this.config.polymarketApiKey,
            secret: this.config.polymarketApiSecret,
            passphrase: this.config.polymarketApiPassphrase,
          },
          type: 'subscribe',
          markets: [tokenId],
        }));
      });

      ws.on('message', (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'book') {
            callback({
              tokenId,
              bids: (msg.bids || []).map((b: any) => ({
                price: parseFloat(b.price),
                size: parseFloat(b.size),
              })),
              asks: (msg.asks || []).map((a: any) => ({
                price: parseFloat(a.price),
                size: parseFloat(a.size),
              })),
              hash: msg.hash || '',
              timestamp: Date.now(),
            });
          }
        } catch (e) {
          // Ignore parse errors
        }
      });

      ws.on('error', (error: Error) => {
        logger.error('WebSocket error', { error: error.message });
      });

      ws.on('close', () => {
        logger.info('WebSocket closed', { tokenId });
      });

      this.wsConnection = ws;
    } catch (error: any) {
      logger.error('Failed to subscribe to order book', { tokenId, error: error.message });
    }
  }

  /**
   * Close WebSocket connection
   */
  closeWebSocket(): void {
    if (this.wsConnection) {
      this.wsConnection.close();
      this.wsConnection = null;
    }
  }
}
