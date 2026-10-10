# 香港 / Linux 服务器部署

将manmanhang部署到自己的 Ubuntu / Debian 服务器，使用 Node.js、Nginx 和 systemd。服务器可位于香港，网站业务源码与仓库根目录一致。

## 下载版与在线分享版

- **下载本项目**：源码和配置模板不包含作者的高德凭据。使用者必须申请自己的 **Web 端（JS API）Key** 及配套安全密钥，配置自己的域名与服务器。没有配置时网页可以打开，但地图服务不可用。
- **打开作者分享的网址**：使用已部署服务器的高德配置，访客无需填写 Key，可以通过微信分享网址。用量计入该服务器所配置的高德账号。

JS API Key 会由浏览器读取；安全密钥只保存在服务器。建议在高德控制台为 Key 设置实际网站的域名白名单，并监控配额。本站代理拒绝普通浏览器跨域调用；Referer / Origin 校验不能代替账号鉴权或限流，也不能保证公共网站的额度绝不被滥用。

## 1. 准备自己的域名与凭据

1. 到 [高德开放平台](https://lbs.amap.com/) 申请自己的 Web 端（JS API）Key 和安全密钥。
2. 将 `server.mjs` 的 `hosts` 和 `way1024.nginx` 的 `server_name` 中的 `example.com`、`www.example.com` 替换为自己的域名。服务器保留 `127.0.0.1`、`localhost` 用于健康检查。
3. 在仓库根目录执行：

```sh
node hongkong-deploy/build-package.cjs .
node --test hongkong-deploy/server.test.mjs hongkong-deploy/private-config.test.cjs
```

构建生成 `hongkong-deploy/way1024-hk.tar.gz`，其中只有网页资源、服务器程序与安装配置，不包含凭据。

复制 `hongkong-deploy/amap.example.json` 为 `hongkong-deploy/amap.private.json`，填写自己的两个值：

```json
{
  "AMAP_JS_KEY": "填写自己的JS_API_Key",
  "AMAP_SECURITY_CODE": "填写自己的安全密钥"
}
```

执行：

```sh
node hongkong-deploy/prepare-private.cjs hongkong-deploy/amap.private.json
```

空值会被拒绝。程序单独生成 `amap.private.env`，不会覆盖已有文件；重新生成前应先备份并移走旧文件。`*.private.json`、`*.private.env`、构建输出和部署包已被 Git 忽略；请勿使用 `git add -f` 强行提交。真实凭据不能上传到 GitHub 或放进网页资源目录。

## 2. 安装到自己的服务器

将部署包和自己的 `amap.private.env` 分别上传到服务器用户的家目录，然后执行：

```sh
mkdir -p ~/way1024
tar -xzf ~/way1024-hk.tar.gz -C ~/way1024
chmod 600 ~/amap.private.env
sudo bash ~/way1024/install.sh ~/amap.private.env
```

安装程序先验证凭据文件，再安装 Nginx、Certbot 和 Node.js 24，核对 Node 下载文件的 SHA-256。网页服务只监听 `127.0.0.1:8080`；Nginx 提供公网访问。私有配置安装到 `/etc/way1024.env`，权限为 `600`，不作为静态文件提供。

`way1024` 是安装目录和服务名称，不需要与域名一致。安装脚本使用 root 权限，会安装系统软件和服务，适用于准备部署本项目的服务器。

## 3. 配置 DNS 与 HTTPS

在自己的云服务器防火墙放行 TCP 80、443。为自己的域名添加指向自己服务器 IP 的 A 记录。DNS 生效后，将下面的示例域名换成自己的域名：

```sh
sudo certbot --nginx -d example.com -d www.example.com
sudo certbot renew --dry-run
```

按提示填写证书联系邮箱并确认服务条款。用 HTTPS 打开网站后，可以直接将网址发送给微信好友，访客使用服务器的配置，无需输入高德 Key。定位与方向权限仍由每位访客单独授权。

## 验证范围

本地测试使用模拟高德响应，验证页面、HTTPS 来源、自己的服务端凭据、缺少配置时的失败行为和代理限制。它们不能证明新服务器到高德的真实网络连通性，也不能替代微信、手机真实定位和方向的实机验收。

官方说明：[安全配置与代理](https://lbs.amap.com/api/javascript-api-v2/guide/abc/prepare)、[域名白名单](https://lbs.amap.com/faq/js-api/map-js-api/create-project/46515)。
