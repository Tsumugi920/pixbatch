# PixBatch · 本地批量图片处理

纯静态、零依赖的批量图片处理单页应用。**所有处理都在你的浏览器里完成，图片从不上传到任何服务器**——没有后端、没有构建工具、没有第三方库，双击 `index.html` 即可离线使用。

## 功能

- 🖼️ **批量加图**：拖拽或点击选择多张图片（JPG / PNG / WebP / GIF / BMP），队列中显示每张的缩略图、原始尺寸和文件大小
- 📐 **尺寸控制**：保持原始尺寸 / 指定宽度（高度按比例自动计算）/ 按百分比缩放
- 🔄 **格式转换**：JPEG / WebP / PNG 输出，JPEG 与 WebP 支持 10–100 质量滑球
- 📊 **前后对比**：每张图片显示处理前后体积、输出尺寸和节省百分比，底部有总体汇总
- ⬇️ **下载**：单张下载，或全部打包下载（ZIP 由原生 JavaScript 实现，无外部库）
- 🏷️ **批量重命名**：前缀 + 序号（可设起始序号与补零位数），如 `trip_001.jpg`、`trip_002.jpg`

## 使用方法

1. 下载本目录下的 `index.html`、`style.css`、`app.js` 三个文件（保持放在同一文件夹）。
2. 用浏览器直接打开 `index.html` 即可，无需安装任何东西、无需联网。
3. 把图片拖进虚线框（或点击选择文件）→ 在左侧设置输出参数 → 点击 **⚙ 全部处理**。
4. 处理完成后逐张下载，或点击 **📦 打包下载 ZIP** 一次性保存。

> 建议使用较新的 Chrome / Edge / Firefox。若浏览器不支持 WebP 编码（如旧版 Safari），WebP 选项会自动禁用。
> PNG 为无损格式，质量滑球对它不生效；GIF 输出后仅保留第一帧（静态图）。

## 输出参数说明

| 参数 | 说明 |
| --- | --- |
| 保持原始尺寸 | 只转格式 / 调质量，不改分辨率 |
| 指定宽度 | 所有图缩放到统一宽度（1–20000 px），高度按原宽高比计算 |
| 按比例缩放 | 按百分比整体缩放（1%–500%） |
| 质量 | 10–100，仅对 JPEG / WebP 生效；越小体积越小 |
| 批量重命名 | 开启后按「前缀 + 序号」命名（序号起始值、补零位数可调）；关闭则保留原文件名、仅换扩展名，重名自动加 `-2`、`-3` |

说明：JPEG 不支持透明，透明图输出 JPEG 时会自动垫白底；ZIP 采用 STORE 方式打包（图片本身已是压缩数据，不再二次压缩，打包速度最快）。

## 部署到 GitHub Pages

### 方式一：网页上传（无需命令行）

1. 在 GitHub 上新建一个仓库（例如 `pixbatch`，Public）。
2. 在仓库页面点击 **Add file → Upload files**，把 `index.html`、`style.css`、`app.js`（以及本 README）拖进去，提交。
3. 进入仓库 **Settings → Pages**，在 **Build and deployment** 里选择：
   - Source：**Deploy from a branch**
   - Branch：**main**，目录 **/(root)**
4. 点击 **Save**，等待 1–2 分钟，访问 `https://<你的用户名>.github.io/pixbatch/` 即可。

### 方式二：git 命令行

```bash
git clone https://github.com/<你的用户名>/pixbatch.git
cd pixbatch
# 把 index.html / style.css / app.js / README.md 放进该目录
git add .
git commit -m "Add PixBatch static app"
git push origin main
```

然后同样到 **Settings → Pages** 按上面的方式开启（main 分支 / root 目录）。

> 若想部署到 `https://<用户名>.github.io/` 根路径，把仓库命名为 `<用户名>.github.io` 并推送这四个文件即可，Pages 会自动开启。

## 目录结构

```
pixbatch/
├── index.html   # 页面结构
├── style.css    # 样式
├── app.js       # 全部逻辑：队列、Canvas 缩放/转码、原生 ZIP、重命名
└── README.md
```

## 隐私

图片只存在于你的内存与本地磁盘：解码用 `Image` + `URL.createObjectURL`，处理用 `canvas`，打包用原生 `Blob`，全程无任何网络请求（可断网验证）。
