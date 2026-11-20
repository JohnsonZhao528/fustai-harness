---
kind: upgrade-guide
description: "每个登录账号都有自己的 Harness 数据根目录；同机首个账号继承共享主目录，后续账号解析到 <home>/accounts/<uid>。"
---

# 账号拥有各自的数据根目录

[English](guide.md) | 中文

## 变更

同一台机器原本只用一个 Harness 主目录（`~/.dsh`，或 `DSH_HOME`）容纳所有账号：会话、设置与已存凭据都读写同一目录，因此换一个账号登录只改变身份，不改变数据所在目录。

[index.ts](../../../../packages/util/home-paths/src/index.ts) 中的 `resolveDshHome()` 现在在取到基础主目录后读取 `<home>/account.json` 并收窄结果。该文件中记录的第一个账号保留 Harness 主目录本身，已有会话、设置与凭据因此继续归属它；之后的每个账号解析到 `<home>/accounts/<uid>`。账号 provider 在登录提交时写入该指针，其中保存 `activeUid` 与 `firstOwnerUid`；目录按 `0700` 创建，指针与凭据文件按 `0600` 写入。指针内容损坏或无法解析会以错误中止解析，而不是退回共享主目录。

进程只在启动时解析一次自己的根目录，因此选中另一个账号根目录的登录要等下一个进程才生效。桌面端每次运行只询问一次（立即重启或稍后），选择立即重启会重启应用并跳过退出确认；Web 登录界面报告同样状态，等待你手动重启 Host。凭据先写入目标根目录，再写指针；启动根目录中遗留的那份副本只在写入确认成功后删除。经由 [dsh-subprocess](../../../../packages/subprocess/subprocess/README.zh.md) 启动的子进程继承已解析的 `DSH_HOME`，因此嵌套命令落在同一根目录。已经指向某个账号根目录的显式 `DSH_HOME` 原样使用，因为指针位于基础主目录内。

## 迁移

1. 在升级后的机器上首次登录前，确定 `~/.dsh` 中已有数据归属哪个账号：最先在此登录的账号保留它，之后的每个账号都在 `~/.dsh/accounts/<uid>` 下从零开始。
2. 完成登录。桌面端在询问时选择重启；浏览器里在登录界面报告变更后重启 Host。
3. 查看 `<home>/account.json` —— `firstOwnerUid` 是拥有共享主目录的账号，`activeUid` 是当前登录的账号，退出登录后为 null —— 并确认第二个账号的文件只出现在 `<home>/accounts/<uid>` 下。
4. 脚本、CI 与私有 patch 中的 `DSH_HOME` 保持指向基础主目录；只有在刻意以单账号启动时才指向 `<home>/accounts/<uid>`，该值不再继续收窄。
5. 不要手工搬移目录。既有会话留在写入位置，后续账号读不到首个账号的数据。
