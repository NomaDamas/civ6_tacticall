# Civ_tacticall

Standalone browser-based controller for Civ agent play.

## ⚡ Fastest Run

This controller is meant to work with the server in [civStation](https://github.com/minsing-jin/civStation.git).

Quickest path:

```bash
npm install
npm run dev
```

Open:

```bash
http://localhost:8787
```

Then connect it to your running `civStation` server.

## 🔌 Relationship

- this folder: client / controller
- `civStation`: server / backend runtime
- `/Users/jinminseong/Desktop/tacticall`: simulation workspace kept separately

## 🗂 Files

- `index.html`, `app.js`
  Browser controller UI
- `server.js`
  Lightweight host for the client UI
- `bridge.js`
  Host-side bridge helper
- `host-config.example.json`
  Host bridge config template

## 🛠 Commands

```bash
npm run dev
npm start
npm run host
```
