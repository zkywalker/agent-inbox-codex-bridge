# Inbox 图片生成工具

Bridge 0.1.14 新增 `agent_inbox_generate_image`，复用网关已保存的供应商、生图模型和当前 Agent 授权。Agent 不需要本地生图 API Key，不接收或转发供应商凭证。

- `action: capabilities` 查询 `enabled / allowed / model / maxConcurrent / generatesOnly`。
- `action: generate` 提交 `prompt`（1–8000 字符）与稳定的 `clientRequestId`（1–128 字符）。
- `action: get` 携带 `jobId` 查询任务，直到 `succeeded / failed / uncertain`。
- 成功返回的 `attachmentId` 使用 `agent_inbox_send_attachment` 显式发到当前会话；生成和查询本身不发消息。

工具仅生成新图片，不支持图生图、模型/URL/凭证覆盖或本地图片路径。失败、未知和网络结果不自动重试或切换供应商；丢失响应后沿用原请求 ID。网关独立验证授权与幂等性。

动态工具仅在新建原生话题时注册。现有 App Server 的 `thread/resume` 没有动态工具追加字段，因此旧话题保持原映射和工具；升级后新建话题使用生图。不能通过修改原生持久化数据、重建旧话题或仅重启来宣称旧话题已获得新工具。

本地回归使用模拟网关结果，覆盖模型收到工具声明、接口参数、重复调用、错误不重试和当前会话附件发送。真实供应商和部署验收另行记录。
