# Virtuell whiteboard

Tre fristående delar i **tre skilda repon** med **tre skilda driftsättningar**:
[WhiteBoard_LOGIN](https://github.com/Stamp00/WhiteBoard_LOGIN) (login-api),
[WhiteBoard_DB](https://github.com/Stamp00/WhiteBoard_DB) (board-api) och
[WhiteBoard_FRONTEND](https://github.com/Stamp00/WhiteBoard_FRONTEND) (frontend).

| Mapp | Vad | Teknik | Databas |
|---|---|---|---|
| `login-api/` | Del 1: registrering + inloggning → JWT | Node 22, Express 5, Prisma 7, bcrypt, jsonwebtoken | egen PostgreSQL-databas (`login_db`) |
| `board-api/` | Del 2: REST-API för boards och lappar | Node 22, Express 5, Prisma 7 | egen PostgreSQL-databas (`board_db`) |
| `frontend/` | Del 3: klientapp | HTML, CSS, vanilla JS (ES-moduler) | – |

## Hur delarna hänger ihop

```
 webbläsare ──POST /auth/login──▶ login-api ──▶ login_db (User)
     │                              │ signerar JWT (HS256, JWT_SECRET)
     │◀────────── { token } ────────┘
     │
     └─ Authorization: Bearer <token> ──▶ board-api ──▶ board_db (Board, Note)
                                           verifierar JWT med samma JWT_SECRET
```

**JWT-innehåll:** `sub` (användar-id), `username`, `role` (`USER`/`ADMIN`), `iss`, `aud`, `iat`, `exp`.
Board-API:n behöver aldrig fråga login-API:n något: den litar på signaturen, läser `sub` och jämför med
boardens `userIds`-array. `ADMIN` har tillgång till alla boards. Token skickas alltid som
`Authorization: Bearer <token>`, och 401-svar har en `WWW-Authenticate: Bearer ...`-header enligt RFC 6750.

**Varför frontend i en egen mapp/repo?** Kravet är tre skilda driftsättningar, och frontend är bara statiska
filer som kan läggas var som helst (people.arcada.fi, Render Static Site, GitHub Pages, nginx på Rahti).
Då är det enklast att hålla den frikopplad; API-adresserna ställs in i `frontend/config.js`.

## Köra lokalt

Kräver en PostgreSQL med två databaser (t.ex. lokalt eller två gratis Neon-databaser):

```bash
cd login-api && cp .env.example .env   # fyll i DATABASE_URL + JWT_SECRET
npm install && npx prisma migrate dev && npm run dev

cd ../board-api && cp .env.example .env   # samma JWT_SECRET!
npm install && npx prisma migrate dev && npm run dev

cd ../frontend && npx serve -l 8080 .     # eller valfri statisk server
```

## API-översikt

### login-api (port 3001)

| Metod | Path | Auth | Svar |
|---|---|---|---|
| POST | `/users` | – | `201` användare · `400` ogiltig input · `409` namnet upptaget |
| POST | `/auth/login` | – | `200 { token, tokenType, expiresIn, user }` · `400` · `401` fel namn/lösenord |
| GET | `/users/me` | Bearer | `200` · `401` |
| GET | `/users` | Bearer | `200 [{ id, username }]` (för delningsdialogen) |
| GET | `/health` | – | `200` |

Lösenord valideras (8–72 tecken), hashas med bcrypt (12 rundor, slumpat salt) och klartext sparas aldrig.
Inloggning ger samma felmeddelande och ungefär samma svarstid oavsett om användaren finns eller inte.

### board-api (port 3002) – alla routes kräver Bearer-token

| Metod | Path | Beskrivning |
|---|---|---|
| GET | `/boards` | boards som användaren har tillgång till |
| POST | `/boards` | skapa board `{ name, userIds? }` (skaparen läggs till automatiskt) |
| GET | `/boards/:id` | en board |
| PATCH | `/boards/:id` | ändra `name`, `description`, `userIds` (bara skaparen/admin) |
| DELETE | `/boards/:id` | radera board + lappar (bara skaparen/admin) |
| GET | `/boards/:id/notes` | alla lappar på boarden (stöder ETag → `304`) |
| POST | `/boards/:id/notes` | ny lapp `{ text?, color?, x?, y?, width?, height?, zIndex? }` |
| GET | `/notes/:id` | en lapp |
| PUT | `/notes/:id` | ersätt lappen (text, color, x, y, width, height krävs) |
| PATCH | `/notes/:id` | delvis uppdatering, t.ex. `{ x, y }` efter drag-and-drop |
| DELETE | `/notes/:id` | radera lapp → `204` |

Statuskoder: `400` ogiltig input/ogiltigt id, `401` saknad/ogiltig/utgången token, `403` ingen rätt till boarden,
`404` finns inte, `500` oväntat serverfel. Felsvar ser alltid ut som `{ "error": "...", "details"?: [...] }`.

CRUD för boards är inget krav, men finns. Vill man fylla i boards manuellt går det också:

```bash
npm run board:create -- "Projektplanering" 1,2,3     # 1,2,3 = användar-id från login-api
# eller direkt i SQL:
INSERT INTO "Board"(name, "userIds", "updatedAt") VALUES ('Projektplanering', '{1,2,3}', now());
```

Gör en användare till admin (i login-databasen): `UPDATE "User" SET role = 'ADMIN' WHERE username = 'alice';`
(Användaren måste logga in på nytt för att få en ny token.)

### Frontend

- Logga in / skapa konto, felmeddelanden på svenska direkt från API:n.
- Skapa lapp med **+ Ny lapp** eller genom att dubbelklicka på ytan.
- Dra lappen i listen upptill; positionen sparas med `PATCH` när musknappen släpps.
- Ändra storlek i nedre högra hörnet, byt färg med prickarna, radera med ✕ (med "Ångra").
- Texten sparas automatiskt 0,6 s efter att man slutat skriva.
- Polling var 3:e sekund (`POLL_INTERVAL_MS`) + direkt när fliken får fokus igen. Express ETag gör att
  oförändrade svar blir `304`. Lappar man själv håller på att dra eller skriva i skrivs inte över.
- Skapa boards och dela dem med andra användare via **Dela**.
- Utgången/ogiltig token → automatisk utloggning med meddelande.

## Driftsättning (Del 5)

Det här kräver dina egna konton, så det måste du göra själv. Rekommenderad kombination (gratis):
**Neon** (databaser) + **Render** (API:erna som Docker-tjänster) + **people.arcada.fi** eller Render Static Site (frontend).

1. **Databaser (Neon):** skapa ett projekt och två databaser, `login_db` och `board_db`.
   Kopiera de två connection strings (med `?sslmode=require`).
2. **Repon:** finns redan (se ovan).
3. **JWT-hemlighet:** `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`.
4. **login-api på Render:** New → Web Service → välj repot → Runtime *Docker*.
   Miljövariabler: `DATABASE_URL` (login_db), `JWT_SECRET`, `CORS_ORIGINS` (frontendens adress).
   Migreringar körs automatiskt när containern startar.
5. **board-api på Render:** samma sak med board-repot, `DATABASE_URL` (board_db), **samma** `JWT_SECRET`.
6. **Frontend:** ändra `config.js` till de två Render-adresserna och ladda upp mappen till
   people.arcada.fi (eller Render → Static Site, ingen build-kommando, publish dir `.`).
7. Lägg till frontendens adress i `CORS_ORIGINS` för båda API:erna.

**CSC Rahti i stället för Render:** Dockerfilerna kör som icke-root och klarar OpenShifts slumpade UID
(testat). Skapa en app per repo från Dockerfile (*Import from Git*), sätt samma miljövariabler som Secrets,
och exponera en Route. Databasen kan vara en PostgreSQL-container i samma Rahti-projekt eller Neon.
Frontend kan köras med `frontend/Dockerfile` (nginx-unprivileged, port 8080).

## Säkerhet

- bcrypt med salt, lösenord valideras och loggas aldrig.
- JWT signeras med HS256, verifieras med fast algoritm, `iss`, `aud` och `exp`.
- `helmet` sätter säkra headers, CORS kan låsas till frontendens domän, request body begränsas i storlek.
- Indata valideras med zod; okända fält ger `400`.
- Token sparas i `localStorage` för att man ska förbli inloggad. Frontend sätter aldrig användartext med
  `innerHTML`, vilket minskar XSS-risken. (En httpOnly-cookie vore säkrare mot XSS, men uppgiften kräver
  Authorization-header.)
