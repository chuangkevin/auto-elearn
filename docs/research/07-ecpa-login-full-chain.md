# full eCPA login chain

- captured 9 entries

## GET https://elearn.hrd.gov.tw/mooc/index.php  → 200
- resp headers: `{'content-type': 'text/html;; charset=UTF-8'}`
- resp body:
```
<!DOCTYPE html>
<html lang="zh-Hant-TW" xmlns="http://www.w3.org/1999/xhtml" prefix='og: http://ogp.me/ns#' xmlns:og="http://ogp.me/ns#" xmlns:fb="http://www.facebook.com/2008/fbml">
<head>
    <meta http-equiv="Content-Type" content="text/html; charset=utf-8"/>
    <meta http-equiv="X-UA-Compatible" content="IE=10">
    <meta name="viewport" content="width=device-width, minimum-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <!-- 把 charset 的 meta tag 調到最前面 -->

    <!-- fb -->
    <meta name="title" content="行政院人事行政總處、公務人員數位學習、e等公務園+學習平臺">
    <meta name="description" property="og:description" content="行政院人事行政總處規劃建置公部門數位學習資源整合平臺「e等公務園+學習平臺」，以「公部門學習資源整合，強化數位培訓新趨勢應用，建構學習資源開放與加值之共享環境」為願景，達成公部門數位學習「單一入口、多元學習、完整記錄、加值運用」之目標，期能透過本平臺做為公部門推動數位學習之最佳選擇，並建構公務人員及民眾全方位之數位學習管道，帶動公務人員有方向及有效率的數位學習與培訓。"/>
    <meta property="og:site_name" content="e等公務園+學習平臺">
    <meta property="og:type" content="website">
    <meta property="og:title" content="行政院人事行政總處、公務人員數位學習、e等公務園+學習平臺">
    <meta property="og:url" content="https://elearn.hrd.gov.tw">
    <meta property="og:image" content="https://elearn.hrd.gov.tw/base/10001/door/tpl/logo.png">
    <meta property="og:description" content="行政院人事行政總處規劃建置公部門數位學習資源整合平臺「e等公務園+學習平臺」，以「公部門學習資源整合，強化數位培訓新趨勢應用，建構學習資源開放與加值之共享環境」為願景，達成公部門數位學習「單一入口、多元學習、完整記錄、加值運用」之目標，期能透過本平臺做為公部門推動數位學習之最佳選擇，並建構公務人員及民眾全方位之數位學習管道，帶動公務人員有方向及有效率的數位學習與培訓。">
    <link href="https://elearn.hrd.gov.tw/base/10001/door/tpl/logo.png" rel="image_src" type="image/jpeg">
    <!-- twitter --
```

## GET https://ecpa.dgpa.gov.tw/webform/clogin.aspx?returnUrl=https://elearn.hrd.gov.tw/sso_verify.php&Naminglogo=https://ecpa.dgpa.gov.tw/webform/logo-hrd.png&showecpa=Y  → 200
- req headers: `{'referer': 'https://elearn.hrd.gov.tw/'}`
- resp headers: `{'content-type': 'text/html; charset=utf-8'}`
- resp body:
```

<!DOCTYPE html>
<html lang="zh-Hant-TW">
    <head>
        <meta http-equiv="X-UA-Compatible" content="IE=edge,chrome=1">
        <meta charset="utf-8">
        <title>人事服務網eCPA</title>
        <meta name="description" content="">
        <meta name="keywords" content="">
        <meta name="author" content="">
        <meta name="robots" content="index,follow">
        <meta http-equiv="Expires" content="Mon,12 May 2010 00:20:00 GMT">
        <meta name="format-detection" content="telephone=no">
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, shrink-to-fit=no">

        <link rel="stylesheet" href="/assets/_css/icon/font-awesome-5/css/all.css" />
        <link rel="stylesheet" type="text/css" href="/assets/_css/bootstrap.min.css">
        <link rel="stylesheet" type="text/css" href="/assets/_css/_main-ui-load.css"/>
        <link rel="stylesheet" type="text/css" href="/assets/fix-bootstrap-myset.css">
        <link rel="stylesheet" type="text/css" href="/assets/fix-bootstrap-mycolor.css">
        <link rel="stylesheet" type="text/css" href="/assets/_css/css-splogin.css">

        <script src="/assets/script/jquery.3.6.0.min.js"></script>
        <script src="/assets/script/modernizr.min.js"></script>
        <!--修正.自動加入css前綴 + 修正.ie的placeholder支援 + 修正.ie的picture支援-->
        <script src="/assets/script/prefixfree.min.js"></script>
        <script src="/assets/script/jquery.placeholder.
```

## POST https://ecpa.dgpa.gov.tw/Home/GetUID  → 200
- req headers: `{'referer': 'https://ecpa.dgpa.gov.tw/webform/clogin.aspx?returnUrl=https://elearn.hrd.gov.tw/sso_verify.php&Naminglogo=https://ecpa.dgpa.gov.tw/webform/logo-hrd.png&showecpa=Y', 'x-requested-with': 'XMLHttpRequest', 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8'}`
- req body: `account=ar8271`
- resp headers: `{'content-type': 'text/html; charset=utf-8'}`
- resp body:
```
F130918271
```

## POST https://ecpa.dgpa.gov.tw/Home/GetApTicketV2  → 200
- req headers: `{'referer': 'https://ecpa.dgpa.gov.tw/webform/clogin.aspx?returnUrl=https://elearn.hrd.gov.tw/sso_verify.php&Naminglogo=https://ecpa.dgpa.gov.tw/webform/logo-hrd.png&showecpa=Y', 'x-requested-with': 'XMLHttpRequest', 'content-type': 'application/x-www-form-urlencoded'}`
- req body: `account=<REDACTED>&password=<REDACTED>&ApID=CrossHRD`
- resp headers: `{'content-type': 'text/html; charset=utf-8'}`
- resp body:
```
6E8205333082052FA003020105A10302010EA20703050000000000A38204A06182049C30820498A003020105A1151B13454350414E45572E444750412E474F562E5457A2153013A003020100A10C300A1B0843726F7373485244A38204613082045DA003020117A10302010EA282044F0482044B4817E9A873DD75A5980C5B9034B354DE3A877DFBB87CA4B46620A0021164ADBE7334F765A8BC1BF120523D688C8AF284220A45E3215F1E7C07C68856F3D9C355AB2650148185B38937862DF35F55775014AC61D2223197694A5F20204510310C30EB896A36B4A66948CCFF54F51B4751B88600428306030E6A308F0BCC9CC22B9274F5F53F18162A64C97C5A85D1BB3F654F787517AD34262F64BAF20DC9E6BB1A60FBCD1278D6D24DA3C91E82EEEFF5CC9C93D7565552BD275280926622A5FDC734B180263BC453F55E936A2B3C983C29321BC0D1BEDD3B391A777A216F82A16FEA9A3266BA658F9438BB4EFEB6958FDB769C368C463EE146F8CED01E77674E7327B5908DE2C44FC8849707C5FE955FBBFAF770F3C85925D22046CB2AB5FF453B0E4857C495DA35D62F2D5B5E8665CB049449FA7F97293C8FB98EFD22FDAE849DA09DCCC0A9C925CB31E586FB22409882CC5C781BAC022FDD5591B4AAFA64EC8987B04D0401EA0348AF1444FD3EBDEDCB90D9DF195E61192833A5227343516945E51682BAB1FA0CC2D72B1C953A190DB6A61A1088C176EC07480DF5F151A419C01AE118A711C0B5D96B5B3A9DC1D8CFE6357678A44F1266A9E208CE9DB4503CB6C32A5C056A62E61C92C061B435C1890EA74907E05E5BF271035BE6D0EE324817A35325B71022413C075EAE337CA0CB274A0CD025A283A7AA15192CAC63A9003C1AC861B5118BDF935DEAADC19C44A1D45141954793F1E288E3A8392786F837ED8E7799370118A8EEB2CC32682880C3FDA51A02C9CE6C6CE6DCD94F51161EFE51B47A540EF6D5AA4186AB1EFE8AFEEBE9CB08D02EDE5710A779DD4FFA99562CDEA3D37A40DC7A4B8E0D1C8B9B7474E438BB180EF39EEF6BDFF0
```

## POST https://ecpa.dgpa.gov.tw/Home/EnterTwoWayLog  → 200
- req headers: `{'referer': 'https://ecpa.dgpa.gov.tw/webform/clogin.aspx?returnUrl=https://elearn.hrd.gov.tw/sso_verify.php&Naminglogo=https://ecpa.dgpa.gov.tw/webform/logo-hrd.png&showecpa=Y', 'x-requested-with': 'XMLHttpRequest', 'content-type': 'application/x-www-form-urlencoded'}`
- req body: `account=<REDACTED>&loginType=0&sn=&ticket=&appId=CrossHRD`
- resp headers: `{'content-type': 'text/html; charset=utf-8'}`
- resp body:
```
0
```

## POST https://ecpa.dgpa.gov.tw/Home/EnterApplicationTwoWay  → 200
- req headers: `{'referer': 'https://ecpa.dgpa.gov.tw/webform/clogin.aspx?returnUrl=https://elearn.hrd.gov.tw/sso_verify.php&Naminglogo=https://ecpa.dgpa.gov.tw/webform/logo-hrd.png&showecpa=Y', 'x-requested-with': 'XMLHttpRequest', 'content-type': 'application/x-www-form-urlencoded'}`
- req body: `appId=CrossHRD`
- resp headers: `{'content-type': 'text/html; charset=utf-8'}`
- resp body:
```
0
```

## POST https://elearn.hrd.gov.tw/sso_verify.php  → 302
- req headers: `{'content-type': 'application/x-www-form-urlencoded', 'origin': 'https://ecpa.dgpa.gov.tw', 'referer': 'https://ecpa.dgpa.gov.tw/'}`
- req body: `loginType=0&APReqEncodedData=<REDACTED>`
- resp headers: `{'content-type': 'text/html;; charset=UTF-8', 'location': 'sso_home.php?ssoid=26170340'}`
- resp body:
```
<binary or unavailable>
```

## GET https://elearn.hrd.gov.tw/sso_home.php?ssoid=26170340  → 302
- req headers: `{'content-type': 'application/x-www-form-urlencoded', 'origin': 'https://ecpa.dgpa.gov.tw', 'referer': 'https://ecpa.dgpa.gov.tw/'}`
- resp headers: `{'content-type': 'text/html;; charset=UTF-8', 'location': '/mooc/index.php'}`
- resp body:
```
<binary or unavailable>
```

## GET https://elearn.hrd.gov.tw/mooc/index.php  → 200
- req headers: `{'content-type': 'application/x-www-form-urlencoded', 'origin': 'https://ecpa.dgpa.gov.tw', 'referer': 'https://ecpa.dgpa.gov.tw/'}`
- resp headers: `{'content-type': 'text/html;; charset=UTF-8'}`
- resp body:
```
<!DOCTYPE html>
<html lang="zh-Hant-TW" xmlns="http://www.w3.org/1999/xhtml" prefix='og: http://ogp.me/ns#' xmlns:og="http://ogp.me/ns#" xmlns:fb="http://www.facebook.com/2008/fbml">
<head>
    <meta http-equiv="Content-Type" content="text/html; charset=utf-8"/>
    <meta http-equiv="X-UA-Compatible" content="IE=10">
    <meta name="viewport" content="width=device-width, minimum-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <!-- 把 charset 的 meta tag 調到最前面 -->

    <!-- fb -->
    <meta name="title" content="行政院人事行政總處、公務人員數位學習、e等公務園+學習平臺">
    <meta name="description" property="og:description" content="行政院人事行政總處規劃建置公部門數位學習資源整合平臺「e等公務園+學習平臺」，以「公部門學習資源整合，強化數位培訓新趨勢應用，建構學習資源開放與加值之共享環境」為願景，達成公部門數位學習「單一入口、多元學習、完整記錄、加值運用」之目標，期能透過本平臺做為公部門推動數位學習之最佳選擇，並建構公務人員及民眾全方位之數位學習管道，帶動公務人員有方向及有效率的數位學習與培訓。"/>
    <meta property="og:site_name" content="e等公務園+學習平臺">
    <meta property="og:type" content="website">
    <meta property="og:title" content="行政院人事行政總處、公務人員數位學習、e等公務園+學習平臺">
    <meta property="og:url" content="https://elearn.hrd.gov.tw">
    <meta property="og:image" content="https://elearn.hrd.gov.tw/base/10001/door/tpl/logo.png">
    <meta property="og:description" content="行政院人事行政總處規劃建置公部門數位學習資源整合平臺「e等公務園+學習平臺」，以「公部門學習資源整合，強化數位培訓新趨勢應用，建構學習資源開放與加值之共享環境」為願景，達成公部門數位學習「單一入口、多元學習、完整記錄、加值運用」之目標，期能透過本平臺做為公部門推動數位學習之最佳選擇，並建構公務人員及民眾全方位之數位學習管道，帶動公務人員有方向及有效率的數位學習與培訓。">
    <link href="https://elearn.hrd.gov.tw/base/10001/door/tpl/logo.png" rel="image_src" type="image/jpeg">
    <!-- twitter --
```
