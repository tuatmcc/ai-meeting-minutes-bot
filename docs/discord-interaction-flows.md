# Discord Interaction のフロー

Worker が受け取る Discord Interaction は HTTP リクエストとしては個別ですが、コマンド・ボタン・選択メニューを通じて複数の Interaction にまたがるフローもあります。この図は現在の実装における入口、分岐、録音開始までの処理を示します。

入口: [`discord-interactions.ts`](../apps/worker/src/api/discord-interactions.ts)。各入口の分岐は [`commands.ts`](../apps/worker/src/api/discord-interactions/commands.ts) と [`components.ts`](../apps/worker/src/api/discord-interactions/components.ts) にあり、Discord の画面生成は [`views.ts`](../apps/worker/src/api/discord-interactions/views.ts) にあります。

## Interaction の振り分け

```mermaid
flowchart TD
    A["POST /interactions"] --> B{"署名・JSON・Application ID が有効か"}
    B -->|いいえ| X["HTTP エラーを返す"]
    B -->|はい| C{"Interaction type"}
    C -->|Ping| P["Pong を返す"]
    C -->|Application Command| D{"コマンド名"}
    C -->|Message Component| E{"custom_id"}
    D -->|meeting| M["VC の設定パネルを表示"]
    D -->|status / imakinta / meeting_notion_retry| O["録音状態に応じた処理"]

    E -->|meeting_stop| O
    E -->|meeting_setup_notion| N["Notion DB 選択画面を表示"]
    E -->|meeting_select_notion_database| Q["選択した DB と次へ・継続利用設定を表示"]
    E -->|meeting_toggle_notion_remember| Q
    E -->|meeting_next_notion_database| R["選択した DB 内の会議ページを表示"]
    E -->|meeting_back_notion_page| Q
    E -->|meeting_next_notion_page| S["選択した親ページで録音開始"]
    E -->|meeting_retry_notion_pages| T["会議ページ候補を再取得"]
    E -->|meeting_select_notion_page| R2["選択した親ページを画面に反映"]
    E -->|meeting_select_saved_notion| R3["保存済み DB の会議ページ候補を表示"]
    E -->|meeting_setup_cancel| M
    E -->|その他| U["未対応の操作として応答"]
```

コマンドは処理を `ExecutionContext.waitUntil` に登録してから応答します。通常は defer response（type 5）、ボタンや選択メニューでは defer update（type 6）を返し、後続処理で元の応答を更新します。

## 設定から録音開始まで

```mermaid
flowchart TD
    A["/meeting"] --> B["保存方法を選ぶ画面を表示"]
    B -->|前回と同じ一覧から選択| G["前回と同じ DB の会議ページ候補を表示"]
    B -->|Notion の設定・変更| D["Notion DB 候補を表示"]
    D --> E["DB を選択"]
    E --> F["継続利用を切り替えて次へ"]
    F --> G["DB 内の会議ページ候補を表示"]
    G --> I["会議ページを選択"]
    I --> J["次へを押す"]
    J --> H["セッションを開始または再開"]
    H --> K{"セッションが starting か"}
    K -->|いいえ| Z["現在のセッション状態を返す"]
    K -->|はい| L["設定に応じて親ページを保存または解除"]
    L --> M["Gateway に start を enqueue"]
    M --> N["Notion 議事録ページを必要に応じて作成"]
    N --> O["Gateway 接続状態と議事録リンクを返信"]
```

`/meeting` では Notion DB を選択してから「次へ」を押し、親ページを選んでもう一度「次へ」を押すと録音を開始します。「戻る」で DB 選択に戻れます。継続利用を有効にすると DB と親ページを VC ごとに保存し、次回の `/meeting` では同じ DB の会議ページ一覧を開いて選択できます。保存先を変更するときは「OFF」に切り替えると、次回以降の保存先設定を解除できます。Notion ページの初回作成に失敗しても録音開始要求は維持し、失敗内容を開始時の返信に含めます。

## その他のコマンド

| コマンド                | 主な分岐・処理                                                      |
| ----------------------- | ------------------------------------------------------------------- |
| `/status`               | 有効なセッション、なければ直近のセッションと Gateway 接続状態を返信 |
| `/imakinta`             | 録音中か、確定文字起こしがあるかを確認して Workers AI で要約        |
| `/meeting_notion_retry` | 直近の Notion 出力を再試行できるか確認して実行                      |

セッション状態と継続利用する親ページは VC ごとの Durable Object に保存されます。Interaction をまたぐ DB 選択と継続利用状態は画面の `custom_id` で継続し、会議ページを選んだ後に録音セッションを開始します。

録音中のメッセージにある「録音を終了」ボタンは、Gateway に stop を enqueue します。
