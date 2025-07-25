# OpenAI Proxy Server

Secure proxy backend to safely use OpenAI API in mobile or web apps.

## 🛡️ Features
- Hides your OpenAI API key
- Simple Express server with CORS support
- Ready to deploy on [Render](https://render.com)

## 🚀 Deploy to Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/nadezhdaz/openai_proxy)

## 🔧 Local Development

```bash
git clone https://github.com/nadezhdaz/openai_proxy
cd openai-proxy
npm install
cp .env.example .env
# Edit .env to include your OpenAI key
npm start
```

## 📦 Endpoints

- `POST /api/ask-gpt`
```json
{
  "prompt": "Your question"
}
```

Returns:
```json
{
  "result": "GPT reply"
}
```
