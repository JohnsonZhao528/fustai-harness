---
kind: upgrade-guide
description: "打开桌面端或 Web 端都需要登录 FustAI 账号；桌面端 Welcome 窗口不再接受用推理 Key 代替登录。"
---

# 打开应用需要登录 FustAI 账号

[English](guide.md) | 中文

## 变更

桌面端 Welcome 窗口原本有两条入口：登录 FustAI 账号，或存一个推理 API Key。下一版本只保留账号这一条。[welcome-api.ts](../../../../apps/desktop/src/welcome-api.ts) 中的 `needsWelcome` 在没有账号凭据时一律返回 true，因此只有推理 Key 会让应用保持关闭，Welcome 只留下登录页和账号页。

Web 端原本不检查账号就直接打开工作区。现在它在 `shell.overlay` 槽位挂一张全屏登录卡，直到账号凭据存入才撤下；被遮住的下方工作区既不响应也不可见，撤下卡片无需重新加载。

账号来自 `https://account.fustai.com`，登录走浏览器设备码流程，期间要求填写邀请码。登录不存推理 Key，模型提供商及其 Key 归「设置 → 模型」配置。

## 迁移

1. 在 `https://account.fustai.com` 取得 FustAI 账号和对应邀请码。
2. 桌面端在 Welcome 里完成浏览器登录；浏览器里打开 Web 端并选择「登录」，凭据存入后工作区即出现。
3. 在「设置 → 模型」逐个添加你要用的模型提供商及各自的 API Key。缺少 Key 现在会在运行时报模型错误，而不再挡住入口。
4. 在没有存过推理 Key 的情况下启动确认迁移：已登录账号直接打开工作区，未登录则打开登录页。
