# mcp-chest-memory

[English](README.md) | **日本語**

- **この MCP を取り込むことで、あとは何もする必要はありません。**
- **自動で作業内容・失敗の原因・調査の結果を、複数プロジェクトにまたがって記憶します。**

**この MCP を導入することで、LLM はあなたと一緒に成長していきます。
ミスや同じ質問をすることがどんどん減っていき、まるであなたの分身のように LLM はふるまうようになっていきます。**

**さらに良い副作用として、LLM の利用トークンを大幅に削減することができます。**

**コーディングエージェントのためのローカルファースト永続記憶（MCP サーバー）。**
エージェントはセッションが終わると全部忘れます。chest は「過去の自分」を耐久的・検索可能な形で残します — 二度と繰り返してはいけない失敗、意思決定とその理由、ファイル単位の編集履歴。すべてあなたのマシン上の単一 SQLite ファイルに保存されます。

記憶ストアは**複数プロジェクト・複数 LLM をまたいで共有**され、人間が意識しなくても LLM が自動で知識を参照・記録します — 同じ指示を何回も出さなくて済むようになります。

Claude Code 向けに最適化（スキル + フック同梱）。MCP クライアントなら何でも動作します。

## 特徴

- **6 層構造化記憶** — `goal` / `context` / `emotion` / `implementation` /
  `realize`（失敗・罠の記録。忘却から保護）/ `learning`（気づき・意思決定）
- **ハイブリッド recall** — SQLite FTS5 trigram 全文検索とベクトル類似度を
  Reciprocal Rank Fusion で融合し、アクセス熱・エンティティ momentum・重要度で重み付け
- **構造的に多言語対応** — trigram トークナイザは形態素解析器不要。
  日本語・中国語・韓国語も空白区切り言語も同じように検索可能
- **オフラインファースト embedding** — 小型多言語モデル
  （`multilingual-e5-small`、ONNX、約 120MB）を transformers.js でローカル実行。
  API キー不要、初回のモデルダウンロード後はネットワーク不要
- **記憶のライフサイクル** — ACT-R 風の activation 減衰、TTL 失効、
  archive-first 削除、supersession 検出、スリープモード統合（consolidation）
- **トークン節約ファイル読み込み** — `chest_read_smart` がチャンクハッシュを
  キャッシュし、前回読み込みからの変更分だけを返す
- **セッション継続** — 作業状態スナップショットがコンテキスト圧縮（compaction）を
  跨いで生存（Claude Code の PreCompact / SessionStart フック）
- **3 つの配備プロファイル** — 同じツール・同じセマンティクスのまま:
  シングル PC / LAN 共有（Docker）/ WAN（nginx + TLS）

## アーキテクチャ

```mermaid
flowchart LR
    subgraph client [任意のクライアント PC]
        CC[Claude Code] -->|stdio| MCP[chest-memory MCP サーバー]
    end

    MCP -->|"local モード (既定)"| DB[(chest.db SQLite + FTS5)]
    MCP -->|"remote モード: REST + Bearer トークン"| NG[nginx TLS - WAN のみ]
    NG --> API[chest-server REST バックエンド Docker]
    MCP -.->|"LAN: REST 直結"| API
    API --> DB2[(ホスト永続化 chest.db)]

    subgraph maintenance [バックグラウンドメンテナンス - 保存後に自動実行]
        IDX[減衰 / スイープ / embedding 補完] --> DB
        IDX2[バックエンド内でも同様] --> DB2
    end
```

| プロファイル | 経路 | データベースの場所 | セットアップ |
|---|---|---|---|
| シングル PC | stdio → プロセス内 SQLite | `~/.chest-memory/chest.db` | `./tools/install.sh` |
| 複数 PC（LAN） | stdio → REST (Bearer) → Docker | ホスト bind mount（`deploy/data/`） | `docker compose up` + `install.sh --remote` |
| 複数 PC（WAN） | stdio → nginx (TLS) → Docker | ホスト bind mount | 上記 + `deploy/nginx.conf.example` |

MCP ツールの仕様は全プロファイルで同一です。stdio サーバーはツール呼び出しを
プロセス内で実行する（local）か、同じ JSON ペイロードをバックエンドへ転送する
（remote）かだけが異なり、バックエンドも全く同じ実行コードを使います。

## クイックスタート（シングル PC）

必要要件: Node.js ≥ 22。

```bash
git clone https://github.com/siosig/mcp-chest-memory.git
cd mcp-chest-memory
./tools/install.sh
```

インストーラーは冪等で、次を一括実行します: ビルド、`~/.chest-memory/` 作成、
SQLite データベース初期化、embedding モデルの事前取得（初回のみダウンロード）、
Claude Code への MCP サーバー登録、`/chest-memory` スキルの配置。
Claude Code を再起動して試してください:

> 「覚えておいて: ステージング DB は毎週月曜にリセットされる」
> 「このエラー前にも踏まなかったっけ？」

アンインストール（データ削除前に確認します）:

```bash
./tools/uninstall.sh            # 対話式
./tools/uninstall.sh --purge    # ~/.chest-memory も削除
```

### 既存の Claude Code 履歴の取り込み

`~/.claude/projects/` 配下の過去セッションすべて（記憶・ファイル編集履歴・
イベント）と、各プロジェクトの自動メモリファイル（`memory/*.md`）を
記憶ストアに取り込み、embedding を補完します:

```bash
./tools/bootstrap-import.sh             # 全件取り込み
./tools/bootstrap-import.sh --dry-run   # 解析・件数レポートのみ（書き込みなし）
```

再実行しても安全です: セッション単位で消去 → 再挿入される冪等設計です。

## 普段の使い方

### やらなければいけないこと: （ほぼ）何もありません

インストール後は、いつもどおり Claude Code で作業するだけです。同梱の
`/chest-memory` スキルがエージェントに recall / 保存のタイミングを教える
ため、記憶の出し入れは自動で行われます。以下はすべて任意です:

- **「覚えておいて: ...」** と言うと、特定の内容を確実に保存できます
- **`/chest-memory`** で直前の文脈を明示的に保存、
  **`/chest-memory status`** でストアの状態を確認できます
- **「これ前にもやらなかったっけ？」** と聞くと recall を強制できます
- **任意**: `chest-memory-setup --yes` で Claude Code のフック（Stop 時の
  セッション自動キャプチャ、コンパクション前後のスナップショット保存/復元）を
  一括設定できます

### 何もしなくても自動で走る処理

- **保存のたび**（`chest_remember`）: エージェントがレイヤーを自動分類し、
  SQLite に保存 → FTS5 索引がトリガーで同期 → ローカルモデルがその場で
  ベクトル化。`realize` レイヤーは自動で忘却保護されます
- **recall のたび**（`chest_recall`）: FTS + ベクトルのハイブリッド検索 +
  減衰考慮ランキング。アクセス熱が更新され、よく使う記憶ほど上位に
  来るようになります
- **セッション中**（スキル駆動）: タスク開始時・履歴のあるファイルの編集前に
  recall、エラー解決後・意思決定後に保存が自動で行われます
- **フック設定済みの場合**: Stop のたびにセッションがキャプチャされ、
  作業状態スナップショットがコンテキスト圧縮を跨いで保持されます
- **保存後のバックグラウンド**（`CHEST_MAINTENANCE_INTERVAL_SEC`、既定 10 分に
  1 回へスロットリング）: activation 減衰の再計算、TTL 失効と archive
  スイープ、supersession 検出、コールドな記憶の統合（consolidation）、
  pending 行の embedding 補完。スケジューラの設定は不要です。手動実行用に
  `chest-index up` も引き続き使えます

### MCP ツール

| ツール | 用途 |
|---|---|
| `chest_remember` | レイヤー指定で記憶を保存（importance / TTL / supersedes 対応） |
| `chest_recall` | 記憶のハイブリッド検索（FTS5 + ベクトル + 減衰考慮ランキング） |
| `chest_recall_file` | ファイルの全編集履歴と編集意図 |
| `chest_update_memory` | 記憶のその場更新（リンクを保持） |
| `chest_list_entities` | 最近の活動順エンティティ一覧 |
| `chest_forget` | ID 指定削除またはリスクベース自動忘却（realize/goal/pin は保護） |
| `chest_consolidate` | コールドな記憶を learning 要約に圧縮 |
| `chest_read_smart` | diff キャッシュ付きファイル読み込み（変更チャンクのみ返却） |

## 複数 PC（LAN）: Docker バックエンド

データを持つホスト側:

```bash
cd deploy
CHEST_API_TOKEN=$(openssl rand -hex 32) docker compose up -d
```

SQLite ファイルはホストの `deploy/data/chest.db` に永続化され、コンテナを
再作成しても残ります。バックエンドのレプリカは必ず 1 つ — データベースの
書き込みプロセスは単一にしてください。

各クライアント PC 側:

```bash
./tools/install.sh --remote http://<host-ip>:8765 --token <同じトークン>
```

これで全クライアントが同じ記憶を共有します。PC-A での `chest_remember` は
PC-B から recall できます。LAN 内でもバックエンドは Bearer トークンを検証します。

## 複数 PC（WAN）: nginx 経由の公開

1. 上記の Docker バックエンドを起動します（nginx が同一ホストの場合は
   ポートマッピングを `127.0.0.1:8765:8765` に変更し localhost に束縛）。
2. [`deploy/nginx.conf.example`](deploy/nginx.conf.example) を nginx 設定に
   コピーし、`server_name` と証明書パスを設定して
   `nginx -t && systemctl reload nginx`。
3. クライアントを公開 URL に向けて登録します:

```bash
./tools/install.sh --remote https://chest.example.com --token <トークン>
```

多層防御: TLS は nginx で終端しつつ、バックエンド自身も Bearer トークンを
検証します — プロキシの設定ミスで無認証のバックエンドが露出することは
ありません。追加の HTTP Basic 認証の例も設定例に含まれています。

## Embedding

embedding は `Xenova/multilingual-e5-small`（量子化 ONNX、384 次元）を
transformers.js でローカル計算します — API キー不要、初回のモデル
ダウンロード後は完全オフラインです（`tools/install.sh` が事前取得します）。

保存処理は embedding の可否に依存しません: モデルが利用できない場合、記憶は
`embedding_status=pending` で保存され、後から `chest-index` が補完します。
ベクトルには生成したモデルと次元がスタンプされ、将来のリリースで同梱モデルが
変わった場合、不一致のベクトルは再索引まで自動的にベクトル検索から除外されます
（全文検索は影響を受けません）:

```bash
chest-index status    # 現行モデルと不一致のベクトル数を表示
chest-index reembed   # pending に戻して再 embedding
```

## 動作の仕組み

### ストレージ

単一の SQLite データベース（WAL モード）に、エンティティ・記憶・エッジ・
イベント・ファイルスナップショット・セッション・統合監査行を保持します。
スキーマは Prisma migration で管理し、FTS5 仮想テーブルと同期トリガーは
同じ migration 内の素の SQL です。

### 全文検索: FTS5 trigram

`memories_fts` は 3 文字部分文字列を索引します
（`tokenize='trigram remove_diacritics 1'`）。これは言語非依存です:
CJK テキストに単語分割も MeCab のような形態素解析器も不要です。
3 文字未満のクエリは LIKE 経路にフォールバックします。スコアは SQLite
組み込みの `bm25()` です。

### ハイブリッドランキング

recall クエリでは両経路が走ります:

1. **FTS 経路** — trigram マッチ、bm25 でランキング
2. **ベクトル経路** — クエリをローカルモデルで embedding し、保存済み
   ベクトルとの cosine 類似度（`(model, dim)` が現行モデルと一致する行のみ）で top-k

2 つのランキングを **Reciprocal Rank Fusion**
（`1/(k + rank_fts) + 1/(k + rank_vec)`）で融合し、Min-Max 正規化して
relevance スコアにします。最終 composite は:

```
composite = (0.45·relevance + 0.25·heat + 0.15·momentum + 0.15·importance)
            × activation × ttl_penalty × supersession_penalty
```

- **heat** — その記憶のアクセス頻度・新しさ（hot/warm/cold/frozen）
- **momentum** — 記憶が属するエンティティの最近の活動量
- **activation** — アクセスログから `chest-index` がオフライン計算する
  ACT-R 風の減衰
- **ttl / supersession ペナルティ** — ハード失効前のソフトな降格

### 記憶のライフサイクル

- **Archive-first**: 減衰で物理削除はしません。行に `archived_at` が付き、
  既定の recall から外れます
- **Supersession**: ほぼ重複する新しい記憶（cosine ≥ 0.97、同一エンティティ/
  レイヤー、90 日窓）が前任を archive し、リンクを記録します
- **Consolidation**: コールドで重要度の低い記憶を（エンティティ, レイヤー）
  単位でクラスタリングし、保護付き `learning` 要約 1 件に圧縮します
- **保護**: `realize` レイヤーと pin 済み（importance ≥ 0.9）の記憶は
  自動忘却されません
- **スナップショット**: セッションごとの作業状態スナップショットが
  コンテキスト圧縮を跨いで生存し、SessionStart フックが復元します

### メンテナンス

メンテナンスは自走します: 保存のあと、サーバーがバックグラウンドで
（応答を遅らせずに）activation 再計算 → 減衰/archive スイープ →
supersession スイープ → pending 行の embedding 補完を実行します。
実行は `CHEST_MAINTENANCE_INTERVAL_SEC`（既定 600 秒）に 1 回へ
スロットリングされ、ファイルロックで手動の `chest-index up` とも
排他されます。`CHEST_AUTO_MAINTENANCE=0` で自動実行を止め、すべて
`chest-index` で手動運用することもできます。

## 設定リファレンス

| 変数 | 既定値 | 意味 |
|---|---|---|
| `CHEST_MODE` | `local` | `local` = プロセス内 SQLite / `remote` = REST バックエンドへ転送 |
| `CHEST_DATA_DIR` | `~/.chest-memory` | データルート（DB・モデルキャッシュ） |
| `CHEST_DB_PATH` | `<data dir>/chest.db` | SQLite ファイル |
| `CHEST_REMOTE_URL` | — | バックエンド URL（remote モード） |
| `CHEST_API_TOKEN` | — | 共有 Bearer トークン（未設定だとバックエンドは起動拒否） |
| `CHEST_PORT` | `8765` | REST バックエンドの待受ポート |
| `CHEST_MAX_CONTENT_CHARS` | `8000` | 記憶本文の最大長 |
| `CHEST_SWEEP_LIMIT` | `500` | embedding スイープ 1 回あたりの最大行数 |
| `CHEST_MAINTENANCE_INTERVAL_SEC` | `600` | バックグラウンドメンテナンスの最短実行間隔（秒） |
| `CHEST_AUTO_MAINTENANCE` | `1` | `0` で保存時トリガーの自動メンテナンスを無効化 |

## Claude Code 連携

- **スキル**: `/chest-memory`（`install.sh` が配置）が直前の会話を
  `realize` / `learning` に自動分類して保存し、判定根拠を表示します。
  `/chest-memory status` でストアの状態を確認できます
- **フック**（任意）: `chest-memory-precompact` がコンテキスト圧縮前に
  作業状態スナップショットを保存、`chest-memory-session-start` が復元、
  `chest-memory-sync`（Stop フック）がセッションを自動キャプチャ —
  `chest-memory-setup --yes` で一括設定できます

## 開発

```bash
pnpm install
pnpm typecheck
pnpm test          # 使い捨て SQLite に対する node:test
pnpm build
./tools/check-rebrand.sh   # リリースゲート: 命名/履歴/言語チェック
```

## ライセンス

[MIT](LICENSE)
