# 原生 Notebook 监控：上游接口请求草稿

ColabDeck 当前已提供一个兼容性 Notebook 来源：它通过 Jupyter 的公开 kernel API 找到活动 Python 内核，并提交受限辅助代码，在 runtime 内启动后台采集器；因此不需要挂载工作区或打开终端，但 Start、Sync samples、Stop 仍需要内核空闲时执行短请求。本文记录的是更完整的上游接口请求，目标是让未来的实现不必向 notebook 内核提交任何采集辅助代码。以下请求仍不是已支持的上游 API。

## Microsoft/vscode-jupyter

**Title: Expose the server provider binding of a running notebook**

A notebook can run on Google Colab, but a companion extension cannot tell which runtime owns the live notebook session. The stable [`kernels.getKernel(uri)` API](https://www.npmjs.com/package/@vscode/jupyter-extension/v/1.1.1) returns a kernel for an already-started notebook without exposing the server provider or its server ID. Server provider registration is not a notebook-to-server lookup. Executing code to infer the binding would use the same queue as the notebook's cells.

Could Jupyter expose a read-only lookup by notebook URI and a change event for that binding? A provider-backed session needs only the provider extension ID, collection ID, and opaque server ID. A picker selection without a live session should not count as connected. Switching kernels, disconnecting, or closing the notebook should invalidate the binding. The lookup should not start a kernel or disclose connection URLs, tokens, or headers.

## Googlecolab/colab-vscode

**Title: Expose read-only runtime metrics for the connected Colab notebook**

A Colab notebook can run cells without a mounted workspace or an open terminal. The Colab extension's [`activate()` entry point](https://github.com/googlecolab/colab-vscode/blob/main/src/extension.ts) does not return an API that companion extensions can use to read runtime metrics. Fetching those metrics should not require submitting code to the notebook's kernel.

Could Colab expose a versioned, read-only API for resource samples on a currently connected Colab runtime, using a verified notebook binding rather than a runtime label? The fields already available to the official Resources view are a useful starting point; GPU utilization can be reported when available. Missing fields should be distinguishable from zero. Colab should own the connection and return no credentials. Polling or subscribing must not open a terminal, drive the kernel picker, mount a folder, or alter the runtime's lifetime.

## 上游 API 的验收目标

- 同时连接两台同名或不同名的 Colab runtime，分别打开两个 notebook；监控按实际绑定读数，不按名称或最近连接猜测。
- 切换内核或断开连接后，旧运行时的样本不能继续显示为当前数据；本地内核不触发 Colab 操作。
- notebook 运行长任务时仍可读到遥测，启动、停止和刷新监控均不向该 notebook 排入代码；当前兼容性实现尚未满足这一点，会在内核空闲时提交短辅助请求。
