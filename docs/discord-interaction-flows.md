# Discord Interaction のフロー

Worker が受け取る Discord Interaction は HTTP リクエストとしては個別ですが、コマンド・ボタン・選択メニューを通じて複数の Interaction にまたがるフローもあります。この図は現在の実装における入口、分岐、録音開始までの処理を示します。

入口: [`discord-interactions.ts`](../apps/worker/src/api/discord-interactions.ts)。各入口の分岐は [`commands.ts`](../apps/worker/src/api/discord-interactions/commands.ts)、[`components.ts`](../apps/worker/src/api/discord-interactions/components.ts)、[`autocomplete.ts`](../apps/worker/src/api/discord-interactions/autocomplete.ts) にあり、Discord の画面生成は [`views.ts`](../apps/worker/src/api/discord-interactions/views.ts) にあります。

## Interaction の振り分け

```mermaid
flowchart TD
    A["POST /interactions"] --> B{"署名・JSON・Application ID が有効か"}
    B -->|いいえ| X["HTTP エラーを返す"]
    B -->|はい| C{"Interaction type"}
    C -->|Ping| P["Pong を返す"]
    C -->|Application Command| D{"コマンド名"}
    C -->|Message Component| E{"custom_id"}
    C -->|Autocomplete| F["Notion の候補を検索して返す"]

    D -->|meeting| M["VC の設定パネルを表示"]
    D -->|meeting_start| S["選択された Notion 項目で録音開始フローへ"]
    D -->|meeting_link_notion_db| L["管理者権限を確認して VC の DB を設定"]
    D -->|meeting_stop / status / imakita / notion_retry| O["録音状態に応じた処理"]

    E -->|meeting_setup_notion| N["Notion DB 選択画面を表示"]
    E -->|meeting_select_notion_database| Q["DB を保存して会議ページ選択へ"]
    E -->|meeting_retry_notion_pages| R["会議ページ候補を再取得"]
    E -->|meeting_select_notion_page| S
    E -->|meeting_setup_cancel| M
    E -->|その他| U["未対応の操作として応答"]
```

コマンドは処理を `ExecutionContext.waitUntil` に登録してから応答します。通常は defer response（type 5）、ボタンや選択メニューでは defer update（type 6）を返し、後続処理で元の応答を更新します。Autocomplete は候補を同期的に返します。

## 設定から録音開始まで

```mermaid
flowchart TD
    A["/meeting"] --> B["保存方法を選ぶ画面を表示"]
    B -->|Notion を設定| C{"サーバー管理権限があるか"}
    C -->|いいえ| X["権限エラー"]
    C -->|はい| D["Notion DB 候補を表示"]
    D --> E["DB を選択"]
    E --> F["DB を VC のセッション設定に保存"]
    F --> G["DB 内の会議ページ候補を表示"]
    G --> H["会議ページを選択"]
    H --> I

    A2["/meeting_start の候補選択"] --> I["録音開始フロー"]
    I --> J{"DB と会議ページが設定済みか"}
    J -->|いいえ| Y["案内メッセージを返す"]
    J -->|はい| K["セッションを開始または再開"]
    K --> L{"セッションが starting か"}
    L -->|いいえ| Z["現在のセッション状態を返す"]
    L -->|はい| M["Gateway に start を enqueue"]
    M --> N["Notion 議事録ページを必要に応じて作成"]
    N --> O["Gateway 接続状態と議事録リンクを返信"]
```

`/meeting_start` の候補検索は、VC に設定済みの Notion DB を対象にします。`/meeting` から選んだ場合は、DB 選択後に同じ DB 内のページを選び、そのページを使って録音を開始します。Notion ページの初回作成に失敗しても録音開始要求は維持し、失敗内容を開始時の返信に含めます。

## その他のコマンド

| コマンド                  | 主な分岐・処理                                                                |
| ------------------------- | ----------------------------------------------------------------------------- |
| `/meeting_link_notion_db` | サーバー管理権限と DB 選択を確認し、VC の設定に保存                           |
| `/meeting_stop`           | 録音中または開始中なら Gateway に stop を enqueue。処理中などは現在状態を返信 |
| `/meeting_status`         | 有効なセッション、なければ直近のセッションと Gateway 接続状態を返信           |
| `/meeting_imakita`        | 録音中か、確定文字起こしがあるかを確認して Workers AI で要約                  |
| `/meeting_notion_retry`   | 直近の Notion 出力を再試行できるか確認して実行                                |

セッション状態は VC ごとの Durable Object に保存されます。Interaction をまたぐフローは Worker のメモリ状態ではなく、次に届く `custom_id` と保存済みのセッション設定をもとに進みます。
