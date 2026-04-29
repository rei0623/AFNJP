using System;

/*
    C# 基礎レッスン 4

    今回のテーマ:
    - int と string の変換
    - Parse と TryParse
    - 数値を合計して表示用テキストにする
    - ラベルに数値を埋め込む

    このファイルは、コメントを読むだけで学習できる教材です。
    チャットでは「次に進んでください」とだけ送れば次のレッスンへ進みます。

    進め方:
    1. コメントを読む
    2. すぐ下のコードを見る
    3. 練習を試す
    4. 保存して実行する
*/

class Program
{
    static void Main()
    {
        /*
            STEP 1: int と string の違いをもう一度確認する

            int は数値です。
            string は文字です。

            見た目が似ていても意味は違います。

            例:
            int score = 100;
            string scoreText = "100";

            score は計算に使えます。
            scoreText は文字として扱われます。

            練習:
            - score を 80 に変える
            - scoreText を "90" に変える
            - 実行前に結果を予想する
        */
        int score = 100;
        string scoreText = "100";

        Console.WriteLine(score + 20);
        Console.WriteLine(scoreText + 20);

        /*
            STEP 2: int を string に変換する

            数値を表示用の文字へ変えたいことはかなり多いです。
            そのときは ToString() を使います。

            下では int totalPrice を string totalPriceText に変えています。

            練習:
            - 2500 を別の金額に変える
            - "円" の前後の表示を変える
        */
        int totalPrice = 2500;
        string totalPriceText = totalPrice.ToString();

        Console.WriteLine("合計金額: " + totalPriceText + "円");

        /*
            STEP 3: 数値をラベルへ埋め込む

            実務では、
            - ラベル
            - メッセージ
            - 画面表示
            に数値を入れたいことがよくあります。

            たとえば:
            "合計: 300円"
            "残り件数: 5"

            下では 3 つの商品の価格を合計して、
            それを表示用テキストラベルにしています。

            練習:
            - applePrice などの数値を変える
            - "円" を "JPY" に変える
            - 商品を 1 つ追加して total を増やす
        */
        int applePrice = 120;
        int breadPrice = 180;
        int juicePrice = 150;

        int total = applePrice + breadPrice + juicePrice;
        string totalLabel = "合計: " + total.ToString() + "円";

        Console.WriteLine(totalLabel);

        /*
            STEP 4: string を int に変換する

            入力やファイルから読んだ値は string で来ることが多いです。
            それを計算したいなら int に変換します。

            int.Parse(...) を使うと、
            文字列を整数に変換できます。

            練習:
            - "35" を別の数字に変える
            - + 5 を + 10 に変える
        */
        string ageText = "35";
        int age = int.Parse(ageText);

        Console.WriteLine("5年後の年齢: " + (age + 5));

        /*
            STEP 5: string 同士は連結、int 同士は計算

            ここはとても大事です。

            "10" + "20" は文字の連結なので "1020" になります。
            10 + 20 は数値の計算なので 30 になります。

            練習:
            - leftText と rightText の値を変える
            - leftNumber と rightNumber も変える
            - 実行前に結果を予想する
        */
        string leftText = "10";
        string rightText = "20";
        Console.WriteLine(leftText + rightText);

        int leftNumber = 10;
        int rightNumber = 20;
        Console.WriteLine(leftNumber + rightNumber);

        /*
            STEP 6: 入力された数値を合計してラベルにする

            これはかなり実践的です。
            ユーザーが入力した数字は string なので、
            int.Parse で数値に変換してから合計します。

            最後に、その合計を表示用の文字列へ変えます。

            練習:
            - 2つ目ではなく3つ目の入力も追加する
            - "合計は" の文を好きな文に変える
        */
        Console.Write("1つ目の数値を入力してください: ");
        string input1 = Console.ReadLine();

        Console.Write("2つ目の数値を入力してください: ");
        string input2 = Console.ReadLine();

        int number1 = int.Parse(input1);
        int number2 = int.Parse(input2);
        int sum = number1 + number2;

        string sumLabel = "合計は " + sum.ToString() + " です。";
        Console.WriteLine(sumLabel);

        /*
            STEP 7: TryParse で安全に変換する

            int.Parse は、数字以外が入るとエラーになります。
            そのため実務では TryParse をよく使います。

            書き方:
            bool success = int.TryParse(text, out int result);

            意味:
            - 変換成功なら success は true
            - 変換失敗なら success は false
            - 成功した数値は result に入る

            練習:
            - sampleText を "123" にする
            - "abc" にして結果を見る
        */
        string sampleText = "abc";
        bool success = int.TryParse(sampleText, out int parsedNumber);

        Console.WriteLine("変換成功したか: " + success);

        if (success)
        {
            Console.WriteLine("変換後の数値: " + parsedNumber);
        }
        else
        {
            Console.WriteLine("数字ではないので変換できませんでした。");
        }

        /*
            STEP 8: 表示専用のラベルを作る別の書き方

            これまでは + で文字をつなげました。
            もう1つよく使うのが文字列補間です。

            $ を付けると、
            {変数名} の形で中に値を入れられます。

            例:
            $"合計: {total}円"

            読みやすいので、今後かなり役立ちます。

            練習:
            - itemCount を変える
            - label を自分の文に変える
        */
        int itemCount = 4;
        string label = $"現在の商品数は {itemCount} 個です。";
        Console.WriteLine(label);

        /*
            STEP 9: 自分で書くミニ練習

            課題A:
            - pointText という string 変数を作る
            - "50" を入れる
            - int に変換して 10 足して表示する

            課題B:
            - price1, price2, price3 という int を作る
            - 合計を求める
            - "請求金額: ○○円" というラベルを作って表示する

            課題C:
            - Console.ReadLine で年齢を入力させる
            - TryParse で安全に int に変換する
            - 成功なら「入力成功: ○○歳」
            - 失敗なら「数字を入力してください」

            課題D:
            - quantity という int を作る
            - ToString を使って string に変える
            - "在庫数: ○○" と表示する

            まだ答えは書きません。
            自分で試してください。
        */

        /*
            今日のまとめ

            今日の重要ポイント:
            - int は数値、string は文字
            - int を string にするなら ToString()
            - string を int にするなら int.Parse()
            - 安全に変換したいなら int.TryParse()
            - 合計値を作って表示用ラベルにする流れは実務でよく使う
            - $"" を使うとラベルが読みやすくなる

            次に進む前のチェック:
            - ToString の役割が分かる
            - Parse と TryParse の違いが分かる
            - 入力値を数値へ変換して計算できる
            - 数値を表示用テキストへ変換できる

            ここまでできたら、チャットで
            「次に進んでください」
            とだけ送ってください。
        */
    }
}
