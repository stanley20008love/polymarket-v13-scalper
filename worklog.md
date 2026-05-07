---
Task ID: 1
Agent: main
Task: 修复V13双引擎模拟盘 - 降低阈值+中文界面+部署

Work Log:
- 分析了无交易原因：MiroFish shouldTrade需≥5%置信度、M101需3/5源同意+50%共识+MiroFish确认三重门控、Scalper需70%汇聚度
- 降低MiroFish shouldTrade: 5% → 1%
- 降低M101决策门控: 3/5(60%) → 2/5(40%) 或 35%共识+MiroFish确认
- 降低Claude Brain方向判断门槛: upProb>0.55 → >0.50, 增加默认方向跟随
- 降低Scalper minConvergence: 70% → 35%, lagThreshold: 0.3% → 0.1%
- 降低M101交易间隔: 30秒 → 15秒
- 全部Dashboard界面翻译为中文
- 添加双策略独立资金显示（剥头皮50U + M101 50U）
- API返回scalperPaperBalance字段
- 编译TypeScript成功，推送到GitHub
- 通过Zeabur CLI upload + GraphQL API部署成功
- 验证：V13.2.0运行中，M101已产生3个持仓交易，中文界面正常

Stage Summary:
- 网站URL: https://polymarketm101.zeabur.app/
- 版本: V13.2.0
- 双引擎均运行中（剥头皮50U + M101 50U）
- M101已在执行模拟交易（3个看跌持仓）
- 全中文界面显示
