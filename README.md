# Pixel Editor

AI エージェントから操作できるドット絵エディター。Electron 製の GUI と、MCP（Model Context Protocol）サーバーが組み込まれていて、Claude Desktop / Claude Code / Cursor など **MCP 対応の任意の AI クライアント** から自然言語でドット絵を描かせることができます。GUI とのリアルタイム同期付き。

## 特徴

- 🎨 **10 種類のツール**: ペン / 消しゴム / 直線 / 矩形 / 矩形塗り / 楕円 / 楕円塗り / バケツ / スポイト / 矩形選択
- 🤖 **MCP サーバー組み込み**: 16 ツールを stdio で公開。AI エージェントから描画指示を受けてキャンバスに反映
- 🔄 **リアルタイム双方向同期**: WebSocket (localhost:17321) で AI 操作と手描き操作がライブ同期
- 🎨 **HSV カラーピッカー** + 21 色パレット + RGB/HEX 入力
- ✏️ **ピクセルアート用機能**: ピクセルパーフェクト線 / ミラー描画 (X/Y) / ブラシサイズ (1〜8) / グリッド表示
- 📐 **ズーム & パン**: マウスホイールでズーム、Space + ドラッグでパン
- ↩️ **Undo/Redo**: 最大 50 段階
- ✂️ **矩形選択**: コピー / カット / ペースト / 削除
- 💾 **PNG 入出力**: スケール指定で書き出し可能 (1×〜32×)
- 🆓 **依存ゼロ**: 既存のドット絵エディター (Aseprite 等) は不要

## インストール

### macOS （ビルド済み .app を使う）

1. このリポジトリをクローン
   ```bash
   git clone https://github.com/mocky70025/pixel-editor.git
   cd pixel-editor
   ```
2. 依存をインストール
   ```bash
   npm install
   ```
3. アプリをビルド
   ```bash
   npm run dist
   ```
4. 生成された `release/mac-arm64/Pixel Editor.app`（または `mac/`）を `/Applications/` にコピー
   ```bash
   cp -R "release/mac-arm64/Pixel Editor.app" /Applications/
   xattr -cr "/Applications/Pixel Editor.app"
   ```
5. Launchpad / Spotlight から「Pixel Editor」を開く

### 開発モード（ビルド済み .app を作らずに動かす）

```bash
npm install
npm start
```

## 使い方

### GUI として使う

1. アプリを起動
2. 左サイドからツール選択、右サイドで色選択、中央のキャンバスに描画

### AI エージェントから操作する

MCP サーバーを登録すれば、Claude などからドット絵を描かせられます。

#### Claude Code に登録（推奨）

```bash
claude mcp add pixel-editor -s user \
  --env ELECTRON_RUN_AS_NODE=1 -- \
  "/Applications/Pixel Editor.app/Contents/MacOS/Pixel Editor" \
  "/Applications/Pixel Editor.app/Contents/Resources/app/dist/main/mcp-server.js"
```

#### Claude Desktop に登録

`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "pixel-editor": {
      "command": "/Applications/Pixel Editor.app/Contents/MacOS/Pixel Editor",
      "args": [
        "/Applications/Pixel Editor.app/Contents/Resources/app/dist/main/mcp-server.js"
      ],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

Claude Desktop を再起動すると `pixel-editor` のツールが使えるようになります。

#### 動作モード

| Pixel Editor 起動状況 | 動作 |
|---|---|
| **起動中** | MCP からの操作が GUI にリアルタイム反映 (`_mode: "remote"`) |
| **未起動** | MCP は単独でメモリ上のキャンバスを使う (`_mode: "standalone"`) |

## キーボードショートカット

### ツール選択
| キー | ツール |
|---|---|
| `B` | ペン |
| `E` | 消しゴム |
| `L` | 直線 |
| `U` / `Shift+U` | 矩形 / 矩形塗り |
| `O` / `Shift+O` | 楕円 / 楕円塗り |
| `G` | バケツ |
| `I` | スポイト（または描画中 `Alt` 押下） |
| `M` | 矩形選択 |

### 編集
| キー | 動作 |
|---|---|
| `Cmd+Z` | 戻る |
| `Cmd+Y` / `Cmd+Shift+Z` | 進む |
| `Cmd+A` | 全選択 |
| `Cmd+C / X / V` | コピー / カット / ペースト |
| `Delete` | 選択範囲を削除 |
| `Escape` | 選択解除 |
| `X` | プライマリ色とセカンダリ色を交換 |

### 表示
| キー | 動作 |
|---|---|
| `Cmd+G` | グリッド表示切替 |
| `H` | 水平ミラー切替 |
| `+` / `-` | ズームイン / アウト |
| `0` | キャンバスをフィット |
| `Space` + ドラッグ | パン |
| `[` / `]` | ブラシサイズ -/+ |

## MCP ツール一覧

| ツール名 | 説明 |
|---|---|
| `new_canvas` | 新規キャンバス作成（最大 128×128） |
| `get_canvas_info` | キャンバス情報取得 |
| `get_canvas_image` | キャンバスを base64 PNG で取得 |
| `set_active_color` | 描画色を設定 |
| `get_palette` / `set_palette` | パレット取得 / 設定 |
| `set_pixel` / `get_pixel` | ピクセル単位の描画 / 取得 |
| `draw_line` | 直線描画 |
| `draw_rect` / `fill_rect` | 矩形描画（中空 / 塗りつぶし） |
| `flood_fill` | バケツ塗り |
| `clear_canvas` | クリア |
| `save_png` / `load_png` | PNG 保存 / 読み込み |
| `image_to_pixelart` | 既存画像を縮小してドット絵化 |

## アーキテクチャ

```
   [Claude / Cursor / Cline 等]
            │ stdio (MCP)
            ▼
   [MCP サーバー (Node)]
            │ WebSocket (localhost:17321)
            ▼
   [Electron メインプロセス]   ← 状態の唯一の真実
            │ IPC
            ▼
   [レンダラ (Canvas UI)]
```

- 状態の真実は Electron 側に集約。MCP サーバーはリモートクライアント扱い
- Electron 未起動時は MCP サーバーが自身のメモリに状態を保持して動作
- 描画はすべて Bresenham 系のアルゴリズムでピクセル精度を保証

## プロジェクト構成

```
src/
├── main/
│   ├── main.ts         # Electron エントリ
│   ├── mcp-server.ts   # MCP サーバー（stdio）
│   └── sync-server.ts  # WebSocket サーバー
├── preload/
│   └── preload.ts      # contextBridge
├── renderer/
│   ├── index.html
│   ├── styles.css
│   └── renderer.ts     # Canvas UI
└── shared/
    ├── canvas-state.ts # 描画ロジック・PNG 入出力
    ├── shared-state.ts # 操作ディスパッチ
    ├── protocol.ts     # WS メッセージ型
    └── types.ts        # RGBA, hex 変換
```

## 開発

```bash
npm install
npm run dev      # tsc -w （TypeScript 監視ビルド）
npm start        # GUI 起動
npm run mcp      # MCP サーバー単体起動 (stdio)
npm run dist     # .app をビルド
```

## ライセンス

未定（個人プロジェクト）
