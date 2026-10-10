# Codex 参考图连线调用规则

批量绑定参考图时，`connect` 自动选择目标工作流第一个兼容的空输入槽位。普通图片和文字只需传来源、目标节点编号：

```js
const state = JSON.parse(await tools.canvas_control({ action: 'read' }));
const result = JSON.parse(await tools.canvas_control({
  action: 'edit',
  revision: state.revision,
  operations: pictureIds.map(sourceId => ({ kind: 'connect', sourceId, targetId })),
}));
```

`pictureIds` 按提示词 Picture 1、Picture 2 等编号排序。操作成功后再次 `read`，核对目标 `parentIds` 的实际槽位；一条成功回执不能代替对应关系核查。

`sourcePort` 是可选的数字来源输出索引，默认 0。来源工作流有多个输出时可以指定；它不是目标图片槽位编号。`connect` 不接受 `targetPort`，传入会被严格校验拒绝。`disconnect` 才支持可选的数字 `targetPort`，用于断开指定目标槽位。已有输入不会被重复 `connect` 覆盖，重绑前应读取状态并按用户要求断开对应连接。

这次把已验证的调用方式补入工具字段说明和每轮助手指令，保留原协议、自动槽位分配、原子编辑及撤销。现有 Codex 会话在下一轮会读取更新后的助手指令；没有修改工具字段或强制更换对话。当前运行的桌面程序需正常重新打开以加载更新后的后端指令。

验证使用真实 Codex bridge、画布执行器、节点连接及工作流槽位分配模块：八图顺序、文字输入保留、来源输出索引、错误参数拒绝、批次失败时无部分提交、重绑与撤销。全程未提交生成任务。
