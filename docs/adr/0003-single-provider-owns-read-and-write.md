# 0003. 读写操作由单一 provider 拥有

- 状态：Accepted
- 日期：2026-08-13

## 上下文

seam 设计时可以把读操作与写操作拆成两个 provider 接口（例如只读 provider 更容易实现、便于第三方接入只读数据源）。但 GitHub 的读与写共享同一身份、同一凭据、同一限流配额。

## 决策

`ctx.github` 的全部操作（搜索、读 issue/PR、写 issue/评论/PR）由单一 provider 接口拥有。`available()` 只做本地廉价检查（凭据 ref 可否解析），不打网络。

## 备选方案

- **读写拆分为两个 provider**：同一账号的身份与鉴权状态会在两个 provider 间产生分歧（各自 resolve 凭据、各自判断可用性），组合矩阵变复杂，而实际并不存在"只读实现"的需求。

## 后果

- provider 实现与注册路径单一，REAL-composition 测试只需一个 fake。
- 未来若真出现只读数据源需求，需要新 ADR 重新权衡（预计通过能力声明而非接口拆分解决）。
