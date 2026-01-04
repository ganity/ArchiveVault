# ArchiveVault

<div align="center">

![ArchiveVault Logo](src-tauri/icons/128x128.png)

**智能文档搜索与管理桌面应用**

[![Build Status](https://github.com/ganily/archivevault/workflows/Build%20Windows/badge.svg)](https://github.com/ganily/archivevault/actions)
[![Release](https://img.shields.io/github/v/release/ganily/archivevault)](https://github.com/ganily/archivevault/releases)
[![License](https://img.shields.io/github/license/ganily/archivevault)](LICENSE)

[下载最新版本](https://github.com/ganily/archivevault/releases/latest) | [使用文档](#使用指南) | [开发文档](#开发指南)

</div>

## 📋 项目简介

ArchiveVault 是一个基于 Tauri 和 React 构建的桌面应用程序，专注于文档搜索、管理和预览功能。支持批量导入 ZIP 压缩包，智能解析其中的 Word、PDF、Excel、图片、视频等文件，并提供强大的全文搜索和内容预览能力。

### 🎯 核心功能

- **批量导入**：支持导入 ZIP 文件或整个文件夹中的 ZIP 文件
- **智能解析**：自动识别并分类 Word、PDF、Excel、图片、视频等文件类型
- **全文搜索**：支持搜索文档内容、字段信息和附件名称
- **内容预览**：在应用内直接预览各种文件格式
- **批注系统**：为文档添加和管理批注
- **结构化提取**：从 Word 文档中提取结构化字段信息

### ✨ 特色优势

- 🔒 **完全离线**：无需网络连接，保障数据安全
- 🚀 **高性能**：基于 Rust 后端，响应迅速
- 📱 **现代界面**：React + TypeScript 构建的直观用户界面
- � **智能搜索**：：支持高亮显示搜索结果和分类筛选
- 📊 **多格式支持**：Word、PDF、Excel、图片、视频等多种格式

## 🖥️ 系统要求

- **操作系统**：Windows 10/11 (x64)
- **内存**：至少 4GB RAM
- **存储空间**：至少 500MB 可用空间
- **网络**：无需网络连接（完全离线运行）

## 📦 安装方式

### 方式一：下载安装包（推荐）

1. 访问 [Releases 页面](https://github.com/ganily/archivevault/releases/latest)
2. 下载适合你系统的安装包：
   - `ArchiveVault_x86_64-pc-windows-msvc.msi` - MSI安装包
   - `ArchiveVault_x86_64-pc-windows-msvc_setup.exe` - NSIS安装程序
   - `ArchiveVault-Windows-Portable.exe` - 便携版（无需安装）

### 方式二：从源码构建

参见 [开发指南](#开发指南) 部分

## 🚀 使用指南

### 1. 导入文档

ArchiveVault 提供两种导入方式：

- **导入 ZIP 文件**：点击"📂 导入 ZIP"按钮，选择一个或多个 ZIP 文件
- **导入文件夹**：点击"📁 导入文件夹"按钮，选择包含 ZIP 文件的文件夹

导入过程中会显示进度条，包含解压、文件分析和索引建立等步骤。

### 2. 搜索和浏览

- **全文搜索**：在搜索框中输入关键词，支持搜索文档内容、字段和附件名称
- **筛选功能**：
  - 按日期范围筛选
  - 按文件类型筛选（主文档、PDF、Excel、图片、视频等）
- **搜索结果**：按档案分组显示，支持展开查看更多匹配内容

### 3. 预览和查看

- **文档预览**：点击搜索结果可直接预览文档内容
- **高亮显示**：搜索关键词在预览中会高亮显示
- **附件查看**：支持预览图片、播放视频等多媒体内容
- **Excel 预览**：可查看 Excel 表格的工作表和单元格内容

### 4. 批注管理

- **添加批注**：在文档预览界面为特定内容添加批注
- **查看批注**：批注会在搜索结果中显示，支持快速定位
- **管理批注**：可删除不需要的批注

### 5. 设置管理

- **库目录设置**：可更改文档库的存储位置
- **缓存清理**：清理预览缓存释放磁盘空间
- **库迁移**：将现有库迁移到新位置

## 🛠️ 开发指南

### 技术栈

- **前端**：React 18 + TypeScript + Vite
- **后端**：Rust + Tauri 2.0
- **数据库**：SQLite（嵌入式）
- **文档处理**：
  - Word：基于 `quick-xml` 解析 docx 格式
  - PDF：文本提取和内容搜索
  - Excel：`calamine` 读取和预览
  - 全文搜索：基于 SQLite FTS5

### 开发环境设置

#### 前置要求

- Node.js 18+ 
- Rust 1.70+
- Git

#### 克隆项目

```bash
git clone https://github.com/ganily/archivevault.git
cd archivevault
```

#### 安装依赖

```bash
# 安装前端依赖
cd frontend
npm install

# 安装 Tauri CLI
cargo install tauri-cli --version "^2.0.0"
```

#### 开发模式运行

```bash
# 在项目根目录
cargo tauri dev
```

#### 构建生产版本

```bash
# 构建前端
cd frontend
npm run build

# 构建 Tauri 应用
cd ../src-tauri
cargo tauri build
```

### 项目结构

```
archivevault/
├── frontend/                 # React 前端
│   ├── src/
│   │   ├── pages/           # 页面组件
│   │   │   ├── SearchPage.tsx      # 搜索页面
│   │   │   ├── SettingsPage.tsx    # 设置页面
│   │   │   └── components/         # 组件目录
│   │   ├── App.tsx          # 主应用组件
│   │   ├── main.tsx         # 入口文件
│   │   └── tauri.ts         # Tauri API 封装
│   ├── package.json
│   └── vite.config.ts
├── src-tauri/               # Rust 后端
│   ├── src/
│   │   ├── main.rs          # 主程序入口
│   │   ├── db.rs            # 数据库操作
│   │   ├── search.rs        # 搜索功能
│   │   ├── importer.rs      # 文件导入
│   │   ├── docx.rs          # Word 文档处理
│   │   ├── excel_preview.rs # Excel 预览
│   │   ├── annotations.rs   # 批注系统
│   │   ├── cache.rs         # 缓存管理
│   │   └── progress.rs      # 进度跟踪
│   ├── Cargo.toml           # Rust 依赖配置
│   └── tauri.conf.json      # Tauri 配置
├── .github/workflows/       # GitHub Actions
└── README.md
```

### 主要依赖

#### Rust 依赖
- `tauri` - 跨平台应用框架
- `rusqlite` - SQLite 数据库，支持 FTS5 全文搜索
- `zip` - ZIP 文件处理
- `calamine` - Excel 文件读取
- `quick-xml` - XML/Word 文档解析
- `jieba-rs` - 中文分词，提升搜索准确性
- `chrono` - 日期时间处理
- `serde` - 序列化/反序列化
- `anyhow` - 错误处理
- `rfd` - 文件对话框

#### 前端依赖
- `react` - UI框架
- `typescript` - 类型安全
- `vite` - 构建工具

## 🤝 贡献指南

我们欢迎各种形式的贡献！

### 报告问题

如果你发现了bug或有功能建议，请：

1. 查看 [Issues](https://github.com/ganily/archivevault/issues) 确认问题未被报告
2. 创建新的 Issue，详细描述问题或建议
3. 提供复现步骤（如果是bug）

### 提交代码

1. Fork 本仓库
2. 创建特性分支：`git checkout -b feature/amazing-feature`
3. 提交更改：`git commit -m 'Add amazing feature'`
4. 推送分支：`git push origin feature/amazing-feature`
5. 创建 Pull Request

### 开发规范

- 遵循现有的代码风格
- 为新功能添加适当的测试
- 更新相关文档
- 确保所有测试通过

## 📄 许可证

本项目采用 [MIT 许可证](LICENSE)。

## 🙏 致谢

- [Tauri](https://tauri.app/) - 跨平台应用开发框架
- [React](https://reactjs.org/) - 用户界面库
- [Rust](https://www.rust-lang.org/) - 系统编程语言

## 📞 联系方式

- 作者：ganily
- 项目主页：[https://github.com/ganily/archivevault](https://github.com/ganily/archivevault)
- 问题反馈：[Issues](https://github.com/ganily/archivevault/issues)

---

<div align="center">

**如果这个项目对你有帮助，请给它一个 ⭐️**

</div>