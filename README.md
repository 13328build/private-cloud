# ☁️ 私人网盘 (Private Cloud)

零依赖 Node.js 网盘服务器，支持断点续传，手机端优先 UI。

## 特性

- **断点续传** — HTTP Range 协议，大文件下载中断后可续传
- **分片上传** — 大文件自动分片，上传中断可重试
- **手机 UI** — 响应式暗色主题，触摸手势（长按菜单、拖拽上传）
- **文件管理** — 浏览、上传、下载、删除、重命名、新建文件夹
- **零依赖** — 纯 Node.js 标准库，无需 npm install
- **安全认证** — 密码保护 + HttpOnly Cookie

## 快速启动

```bash
# 直接运行
node server.js

# 自定义密码和端口
CLOUD_PASSWORD=mypassword PORT=8080 node server.js

# 自定义存储目录
STORAGE_DIR=/data/files node server.js
```

访问 `http://localhost:9800`，默认密码 `admin123`。

## 设为系统服务（开机自启）

```bash
# 编辑密码和路径
cp private-cloud.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now private-cloud
```

## 断点续传原理

### 下载

服务端实现 HTTP Range 请求（RFC 7233）：

1. 客户端 `HEAD` 请求获取文件大小和 `Accept-Ranges: bytes`
2. 大文件（>5MB）自动分 4MB 块下载
3. 使用 `Range: bytes=start-end` 请求每个块
4. 服务端返回 `206 Partial Content` + `Content-Range` 头
5. 进度保存在浏览器 IndexedDB，页面刷新后可续传
6. 所有块下载完后合并为完整文件

### 上传

1. 小文件（<10MB）：直接 PUT 上传
2. 大文件：自动分 4MB 片段上传
3. 服务端接收所有分片后自动合并

## 配置项

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `PORT` | 9800 | 监听端口 |
| `HOST` | 0.0.0.0 | 监听地址 |
| `CLOUD_PASSWORD` | admin123 | 登录密码 |
| `STORAGE_DIR` | ~/cloud-storage | 文件存储目录 |

## API

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/login` | POST | 登录 |
| `/api/list?path=/` | GET | 文件列表 |
| `/api/file/path` | GET/HEAD | 下载文件（支持 Range） |
| `/api/upload?filename=x` | PUT | 上传文件 |
| `/api/mkdir` | POST | 创建文件夹 |
| `/api/delete` | POST | 删除文件/文件夹 |
| `/api/rename` | POST | 重命名 |
| `/api/usage` | GET | 磁盘使用情况 |

## 安全建议

- ⚠️ 生产环境务必修改默认密码
- 建议通过 Nginx 反代 + HTTPS
- 不建议暴露在公网无认证使用
