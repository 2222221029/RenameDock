# RenameDock · 飞牛 NAS 批量重命名工具

这是由原有两个桌面项目合并后的 NAS Web 版。它保留完整的规则流水线、扫描筛选、媒体变量、实时预览、冲突处理、任务控制、方案和撤销能力，并以 Docker 容器运行。浏览器 UI 是全新设计，不依赖 Tkinter，也不会读取没有挂载进容器的主机路径。

## 合并后的功能

- 18 类有序规则：插入、删除、移除、替换、重排、扩展名、字符清理、大小写、序号、随机文本、数字补零、名称清理、转写、正则、日期格式化、手动名称列表、变量模板和条件处理。
- 模板变量：`{name}`、`{original}`、`{ext}`、`{n:03d}`、`{date}`、`{time}`、文件创建/修改/访问时间、`{size}`、`{sha256}`、`{random}`、`{uuid}`。
- 媒体变量：图片尺寸/拍摄时间/相机，音频标题/艺术家/专辑/音轨/时长，PDF 标题/作者/主题（读取失败时安全跳过）。
- 扫描与筛选：递归、文件夹、隐藏项、扩展名、名称正则、大小、修改时间、自然排序、SHA-256 内容去重。
- 安全执行：先预览、同目录改名、两阶段临时名称、交换名称、报错/跳过/自动编号/覆盖策略、后台进度、暂停、继续和安全取消。
- 恢复能力：最多保存 100 个历史批次，配置卷持久化，服务重启后仍可撤销；规则方案也可保存和加载。
- NAS 安全边界：后端对扫描、预览、执行和撤销的每条路径重新校验，只允许访问 `NAS_ROOTS` 下的挂载目录。
- 可选访问令牌：设置 `RENAMEDOCK_TOKEN` 后，浏览器需要输入相同令牌才能调用文件接口。

## 在飞牛 NAS 上部署

### 使用 Compose

1. 把整个项目上传到飞牛 NAS，例如 `/vol1/docker/renamedock`。
2. 编辑 `docker-compose.yml`，把下面这行左侧的 `/vol1` 改成需要管理的 NAS 目录：

   ```yaml
   - /vol1:/data
   ```

3. 如需访问令牌，取消 `RENAMEDOCK_TOKEN` 一行的注释并修改令牌。
4. 启动服务：

   ```bash
   docker compose pull
   docker compose up -d
   ```

5. 浏览器访问 `http://NAS的IP:2080`。

飞牛 Docker 管理界面也可以直接导入此 Compose 文件。如果界面能浏览文件但执行时报权限不足，请检查飞牛共享目录是否允许容器写入。

需要挂载多个共享目录时，在 `docker-compose.yml` 的 `volumes` 下增加绑定，并全部放在 `/data` 内，例如：

```yaml
- type: bind
  source: /vol2/archive
  target: /data/archive
  read_only: false
```

### 使用 Docker 命令

```bash
docker pull ghcr.io/2222221029/renamedock:latest
docker run -d --name renamedock --restart unless-stopped \
  -p 2080:8080 \
  -e TZ=Asia/Shanghai \
  -e NAS_ROOTS=/data \
  -e RENAMEDOCK_TOKEN=请替换为强令牌 \
  -v /vol1:/data \
  -v /vol1/docker/renamedock/config:/config \
  ghcr.io/2222221029/renamedock:latest
```

镜像基于官方 Python slim，支持 Docker 可用的 x86_64 与 ARM64 飞牛设备。服务端使用单 Gunicorn 进程和多线程；单进程可确保后台任务状态在轮询时保持一致。

## 本机开发

```powershell
python -m pip install -r requirements.txt
$env:NAS_ROOTS = "C:\需要测试的目录"
python web_app.py
```

访问 `http://127.0.0.1:8080`。未设置 `NAS_ROOTS` 时，开发模式只允许访问项目目录。

## 测试

```powershell
python -m unittest discover -s tests -v
```

## 重要安全说明

- “覆盖现有目标”会在批次成功后永久删除被覆盖的文件或目录；默认策略是“冲突时停止”。
- 历史记录保存的是容器内路径。修改卷挂载位置后，旧批次可能无法撤销。
- 不要把 `/` 作为 `/data` 挂进容器；只挂载确实需要管理的共享目录。
- 同一批次不允许同时重命名父文件夹和其内部项目，以避免目录移动导致路径歧义；请分批执行。
- 原桌面项目保留在 `RenameDock` 的上级目录中；当前目录是可独立复制和部署的 Docker 项目。

