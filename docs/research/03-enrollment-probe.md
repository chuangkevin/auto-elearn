# v5 未報名課程頁面 & 報名端點驗證


## /info/10047012
- Final: `https://elearn.hrd.gov.tw/info/10047012`  Title: `e等公務園+學習平臺 - 僑務委員會115年度上半年資通安全暨個資保護認知宣導教育訓練`
- 可能的報名/上課按鈕 1 個：
  - ✓ [BUTTON] `報名課程`  href=``  onclick=`enployCourse(10047012);`  cls=`btn btn-primary btn-blue btnAction`  id=``  disabled=False
- inline script 片段 (2 個)：

  ### script [0] (length 2531):
```js

        
        // ajax response 字串
        var globalAjaxResponse = "";
        function setGlobalAjaxResponse(res){
            globalAjaxResponse = res;
            return true;
        }
        function globalFilterHtml(html){
            var parsed = $.parseHTML(html);
            var filteredHtml = $('<div/>').append(parsed).html();
            return filteredHtml;
        }

        function globalHtmlEncode(value){
            // 建立一個暫存的div元素，並使用text()將內容存成html編碼文字後再用html()取出
            if (value) {
                return $('<div/>').text(value).html();
            } else {
                return '';
            }
        }

        function globalFilterXss(str) {
            str = str.replace(">", "");
            str = str.replace("<", "");
            return str;
        }

        function globalGetObjectVal(obj) {
            return obj.val();
        }

        function globalGetObjectText(obj) {
            return obj.text();
        }

        function globalSetObjectText(obj, txt) {
            return obj.text(txt);
        }

        function globalGetObjectHtml(obj) {
            return obj.html();
        }

        function globalGetObjectAttr(obj, attrName, doFilterXss=1) {
            if (doFilterXss != 1) {
                return obj.attr(attrName);
            }
            return globalFilterXss(obj.attr(attrName));
        }

        function globalGetObjectProp(obj, propName, doFilterXss=1) {
            if (doFilterXss != 1) {
                
```

  ### script [1] (length 12798):
```js

        var introVideoPath = '';
        var introVideoPosterPath = '';
        var confirmsign = "確認要報名此課程？";
        var confirmwithdrawal = "退選課程後將倒扣選課所贈送的學習金幣，並且不保留學習紀錄、測驗及問卷作答結果，您是否確定要退選?";
        var courseRatingAvgScore = "5.0";
        /* 是否可給予課程評分 */
        var courseRatingEnable = false;

        var outerCourseTicket = '';

        
        /**
         * 切換到探索課程的某一群組
         */
        function gotoCategory(grpid) {
            document.frmGoCategory.groupId.value = grpid;
            document.frmGoCategory.submit();
        }

        function gotoCourse(csid) {
            $.ajax({
                url: '/mooc/controllers/course_ajax.php',
                type: 'POST',
                dataType: 'json',
                data: {
                    'course_id': csid,
                    'action': 'checkCoursePass'
                },
                success: function(res) {
                    console.log(res.co_isreadtimevalid);
                    if (res.co_isreadtimevalid == "Y") {
                        // 顯示確認訊息
                        $.fancybox.open({
                            src: '<div style="padding:30px;max-width:500px;text-align:center;">' +
                         '<div style="font-size:18px;line-height:1.6;margin-bottom:30px;color:#333;">您已完成此課程，重新學習將無法重複取得時數，確定要繼續嗎？</div>' +
                         '<div style="display:flex;justify-content:center;gap:15px;">' +
                         '<button id="confirmBtn" class="btn btn-primary btn-blue 
```
- onclick 含 enploy/enroll/報名 的元素：
  - [BUTTON] `報名課程`  onclick=`enployCourse(10047012);`  id=``  cls=`btn btn-primary btn-blue btnAction`
- 完整 HTML 已存 `info_10047012.html`

## /info/10046970
- Final: `https://elearn.hrd.gov.tw/info/10046970`  Title: `e等公務園+學習平臺 - 115 年度資安暨個資保護基礎認知課程`
- 可能的報名/上課按鈕 1 個：
  - ✓ [BUTTON] `報名課程`  href=``  onclick=`alert('報名身分不符，請詳見課程簡介'); return false;`  cls=`btn btn-primary btn-blue btnAction`  id=``  disabled=False
- inline script 片段 (2 個)：

  ### script [0] (length 2531):
```js

        
        // ajax response 字串
        var globalAjaxResponse = "";
        function setGlobalAjaxResponse(res){
            globalAjaxResponse = res;
            return true;
        }
        function globalFilterHtml(html){
            var parsed = $.parseHTML(html);
            var filteredHtml = $('<div/>').append(parsed).html();
            return filteredHtml;
        }

        function globalHtmlEncode(value){
            // 建立一個暫存的div元素，並使用text()將內容存成html編碼文字後再用html()取出
            if (value) {
                return $('<div/>').text(value).html();
            } else {
                return '';
            }
        }

        function globalFilterXss(str) {
            str = str.replace(">", "");
            str = str.replace("<", "");
            return str;
        }

        function globalGetObjectVal(obj) {
            return obj.val();
        }

        function globalGetObjectText(obj) {
            return obj.text();
        }

        function globalSetObjectText(obj, txt) {
            return obj.text(txt);
        }

        function globalGetObjectHtml(obj) {
            return obj.html();
        }

        function globalGetObjectAttr(obj, attrName, doFilterXss=1) {
            if (doFilterXss != 1) {
                return obj.attr(attrName);
            }
            return globalFilterXss(obj.attr(attrName));
        }

        function globalGetObjectProp(obj, propName, doFilterXss=1) {
            if (doFilterXss != 1) {
                
```

  ### script [1] (length 12798):
```js

        var introVideoPath = '';
        var introVideoPosterPath = '';
        var confirmsign = "確認要報名此課程？";
        var confirmwithdrawal = "退選課程後將倒扣選課所贈送的學習金幣，並且不保留學習紀錄、測驗及問卷作答結果，您是否確定要退選?";
        var courseRatingAvgScore = "0.0";
        /* 是否可給予課程評分 */
        var courseRatingEnable = false;

        var outerCourseTicket = '';

        
        /**
         * 切換到探索課程的某一群組
         */
        function gotoCategory(grpid) {
            document.frmGoCategory.groupId.value = grpid;
            document.frmGoCategory.submit();
        }

        function gotoCourse(csid) {
            $.ajax({
                url: '/mooc/controllers/course_ajax.php',
                type: 'POST',
                dataType: 'json',
                data: {
                    'course_id': csid,
                    'action': 'checkCoursePass'
                },
                success: function(res) {
                    console.log(res.co_isreadtimevalid);
                    if (res.co_isreadtimevalid == "Y") {
                        // 顯示確認訊息
                        $.fancybox.open({
                            src: '<div style="padding:30px;max-width:500px;text-align:center;">' +
                         '<div style="font-size:18px;line-height:1.6;margin-bottom:30px;color:#333;">您已完成此課程，重新學習將無法重複取得時數，確定要繼續嗎？</div>' +
                         '<div style="display:flex;justify-content:center;gap:15px;">' +
                         '<button id="confirmBtn" class="btn btn-primary btn-blue 
```
- onclick 含 enploy/enroll/報名 的元素：
  - [BUTTON] `報名課程`  onclick=`alert('報名身分不符，請詳見課程簡介'); return false;`  id=``  cls=`btn btn-primary btn-blue btnAction`
- 完整 HTML 已存 `info_10046970.html`

## enploy / enroll 網路請求總計
- 共 0 筆（造訪 info 頁期間）