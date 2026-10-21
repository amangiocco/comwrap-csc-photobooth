# Photobooth – video wall

Server che riceve i video generati da un workflow n8n e li mostra come un LED wall, e le foto
da unire a un template PSD e stampare (vedi «Stampa delle foto»). Il wall: card
quadrate, 6 per riga, ognuna col suo video in loop. L'ultimo arrivato va in alto a sinistra e
gli altri scalano verso destra e poi a capo. Il wall è una pagina web: si apre da qualsiasi
browser della rete.

## Avvio

Serve Node.js 20 o successivo.

```sh
npm install
npm start
```

Al primo avvio vengono generate la chiave API (per n8n e il servizio di stampa) e la password
della console (utente `admin`), salvate in `.env` e stampate **una sola volta**; della password
si salva solo l'hash. Per cambiarla: `npm run set-password` (con `-- --user <nome>` cambia anche
l'utente), poi riavvia il server.
Il server ascolta su tutte le interfacce sulla porta 80 (se è occupata usa la prima libera da
4700) e stampa gli indirizzi: `http://localhost:<porta>` e quelli di rete. Con lo stesso comando
parte anche il servizio di stampa. Si ferma con Ctrl+C.

Configurazione in `.env` (vedi `.env.example`):

| Variabile | Default | Significato |
|---|---|---|
| `PHOTOBOOTH_API_KEY` | generata | chiave per n8n e il servizio di stampa (non apre la console) |
| `ADMIN_USER` | `admin` | utente della console |
| `ADMIN_PASSWORD_HASH` | generata | hash della password della console (`npm run set-password`) |
| `PORT` | 80, altrimenti prima libera da 4700 | porta fissa |
| `PUBLIC_URL` | `http://localhost:<porta>` | indirizzo usato nei link e negli esempi dell'admin |
| `PRINT_AGENT` | acceso | `0` = non avviare qui il servizio di stampa (server su AWS) |
| `WALL_PLACEHOLDER` | video YouTube di esempio | video delle card iniziali (YouTube o URL video; vuoto = nessuno) |
| `WALL_SHOWCASE_SECONDS` | `8` | secondi di presentazione al centro di ogni video nuovo (0 = nessuna) |
| `HOST` | `::` (IPv4 e IPv6) | interfaccia di ascolto |
| `DATA_DIR` | `data` | eventi (`events.json`) e video (`media/<evento>/`) |
| `MAX_UPLOAD_MB` | `500` | dimensione massima di un video |
| `LOG_RETENTION_DAYS` | `2` | giorni di log tenuti (`logs/`, tab «Log» dell'admin) |

## Uso

1. Apri `http://localhost:80/admin` ed entra con utente e password della console.
2. Crea un evento: nasce **spento**.
3. Apri il wall (`/<evento>/wall`) sul PC collegato allo schermo; clic o tasto **F** per lo
   schermo intero.
4. **Accendi** l'evento: da quel momento accetta video e il wall li riproduce. Spento, il wall
   diventa nero e gli invii ricevono `409`.

All'inizio il wall mostra una riga di card col segnaposto (`WALL_PLACEHOLDER`, serve internet sul PC
del wall; si accendono e spengono per evento con «Card di esempio sul wall» nell'admin, e
«Elimina tutti i video» le spegne insieme ai video): si comportano come i video più vecchi, i nuovi le spingono avanti e fuori dallo schermo. I video più vecchi si raggiungono scorrendo in verticale (rotella,
touch o barra laterale, visibile mentre si muove il mouse); dopo un minuto senza interazioni il
wall torna in cima. Si riproducono solo i video visibili sullo schermo.

Ogni video che arriva mentre il wall è aperto viene prima **presentato al centro**, in primo
piano con una cornice luminosa e la scritta «<userid>, ecco il tuo video», poi vola nella prima
card in alto a sinistra e le altre scalano. Se ne arrivano più insieme, si presentano in fila. Dall'admin
si vedono le anteprime e si possono eliminare video o interi eventi; il wall si aggiorna da solo.

## Rete

Sullo stesso PC il server risponde su `http://localhost:<porta>`; dagli altri PC della rete
sull'IP del PC (stampato all'avvio). Se n8n gira in Docker sullo stesso PC, al posto di
`localhost` usa `host.docker.internal`. Al primo avvio Windows chiede di consentire Node.js nel
firewall: va consentito almeno sulle reti private. Se il server è esposto su internet conviene
metterlo dietro un reverse proxy con HTTPS (chiave API e password altrimenti viaggiano in chiaro).

## Accessi

Due accessi separati:

- **Chiave API** (`PHOTOBOOTH_API_KEY`, header `x-api-key` o `Authorization: Bearer`): per n8n e il
  servizio di stampa. Invii di video, foto e mail, coda di stampa, gestione e pulizia degli eventi.
  **Non** apre la console né le sue impostazioni.
- **Console** (`/admin`): utente e password, poi una sessione in un cookie `HttpOnly`,
  `SameSite=Strict`, che dura 12 ore e si rinnova finché si usa la console (in memoria: dopo un riavvio
  del server si rientra). Può fare tutto; solo la console gestisce account email, modelli email,
  template di stampa e log. Nel browser non resta nessuna chiave: «Copia» nelle chiamate per n8n la
  chiede al server. Dopo 5 password sbagliate dallo stesso indirizzo l'accesso si blocca per 5 minuti.

Wall, pagina delle stampe e i loro dati restano pubblici, in sola lettura.

## Più schede e più schermi

Wall e pagina delle stampe ricevono gli aggiornamenti con un **WebSocket**, che non occupa una
delle 6 connessioni che il browser concede verso lo stesso sito: si possono tenere aperte quante
schede si vuole senza bloccare le altre pagine. Nel wall ogni card visibile riproduce il suo video; i
player YouTube partono uno alla volta (ogni mezzo secondo) per non intasare il browser, e le card
fuori dallo schermo restano in pausa (i file) o tornano alla copertina (YouTube) finché non
ricompaiono.

## Spazio su disco

Per ogni foto il server conserva **la foto originale** (`data/photos/`, serve per ristampare) e
**un'anteprima leggera** del foglio (`data/previews/`, circa 150 KB, per la pagina delle stampe).
Il servizio di stampa compone il foglio in memoria e crea il PDF in una cartella temporanea che
cancella subito dopo la stampa: sul PC della stampante non resta nulla, a meno di
`PRINT_KEEP_FILES=1` (copia di ogni foglio in `data/prints/`). Foto e anteprime si cancellano con
«Elimina» sulla foto, con «Elimina tutte le foto» nell'admin o eliminando l'evento («Elimina tutti i
video» fa lo stesso per i video); lo stesso vale per i video (`data/media/`), che sono
la parte più pesante.

## Template dall'admin

Ogni evento può avere il suo template, caricato dall'admin («Template di stampa»): il PSD e, se
servono, i font `.otf`/`.ttf` (anche nello stesso caricamento). Il server lo controlla con lo
stesso codice della stampa e mostra un'anteprima con una foto e valori di esempio, le misure, il
livello della foto, i testi variabili con lo stato dei loro font e cosa va sistemato. Si può
sostituire il PSD, aggiungere o togliere font, o rimuovere il template.

Il servizio di stampa scarica il template dell'evento dal server (con la chiave) e lo tiene in
cache: ogni modifica vale dalla stampa successiva, senza riavviare nulla e senza copiare file sul
PC di stampa. Un evento senza template caricato usa il PSD della cartella `templates/` del PC.

## Carta, bordi e margini

Ogni evento ha le sue **impostazioni di stampa**, nell'admin («Impostazioni di stampa», con
un'anteprima del foglio in scala). Valgono dalla stampa successiva, ristampe comprese.

- **Formato carta**: Foto 10×15 (4×6″, il default: la carta lucida classica, con le stesse
  proporzioni del template), 9×13, 13×18, 15×20, 20×30, A6, A5, A4, «come il template» o
  personalizzato in mm
- **Orientamento**: automatico (come la foto), verticale, orizzontale
- **Adattamento**: intera senza tagli, oppure riempi il foglio tagliando i bordi
- **Bordo**: senza bordo (al vivo), uniforme, stile istantanea (fascia in basso più alta);
  spessore in mm e colore
- **Margini**: alto, destra, basso, sinistra in mm (carta lasciata bianca)
- **Scala della stampante**: adatta all'area stampabile, oppure dimensione reale
- **Formato nel driver**: il nome del formato come lo chiama il driver (es. `4x6`), se la
  stampante non lo sceglie da sola

Il servizio di stampa impagina il foglio a 300 dpi e lo stampa come PDF di quella misura; la
finestra di stampa della pagina `/<evento>/print` mostra il foglio e le impostazioni usate.

Gli eventi non possono chiamarsi come gli indirizzi del server (`admin`, `api`, `static`,
`media`, `previews`, `wall`, `print`).

## Configurare n8n (nodo HTTP Request)

- **Method**: `POST`
- **URL**: `http://localhost:80/<evento>/wall` (stesso indirizzo della pagina del wall:
  GET la mostra, POST invia il video; vale anche il vecchio `/api/events/<evento>/videos`)
- **Authentication**: nessuna; in **Send Headers** aggiungi `x-api-key` = la chiave
  (in alternativa `Authorization: Bearer <chiave>`)

Poi una delle due forme di body:

**File binario** – il video è già un dato binario nel workflow:
- **Body Content Type**: `Form-Data`
- parametro di tipo **n8n Binary File**, nome qualsiasi (es. `video`), *Input Data Field Name*
  = il campo binario (di solito `data`)
- facoltativo: parametri testo `userid` (il nome mostrato sul wall) e `title`

**URL** – il generatore restituisce un link al video:
- **Body Content Type**: `JSON`
- body `{ "url": "{{ $json.videoUrl }}", "userid": "{{ $json.userid }}", "title": "..." }`
  (anche un link YouTube: non viene scaricato, il wall lo incorpora)

Il server scarica il video (solo http/https, entro `MAX_UPLOAD_MB`, timeout 2 minuti).

Formati accettati: mp4, webm, mov, m4v, ogv. Per la riproduzione nel browser è consigliato
**MP4 H.264**.

Risposte: `201` con i dati del video; `401` chiave errata; `404` evento inesistente;
`409` evento spento; `413` video troppo grande; `415` non è un video; `502`/`504` download
fallito o scaduto.

Prova da terminale (tutte le chiamate, già con l'evento e la chiave, sono nell'admin in
«Chiamate da n8n», con il pulsante «Copia»):

```sh
curl -X POST "http://localhost:80/<evento>/wall" \
  -H "x-api-key: <chiave>" -F "video=@video.mp4" -F "userid=Mario" -F "title=Prova"
```

## Stampa delle foto

n8n manda le foto da stampare al server, come i video:

- **URL**: `http://localhost:80/<evento>/print` (come la pagina delle stampe; vale anche il
  vecchio `/api/events/<evento>/photos`), header `x-api-key`
- **Form-Data**: un file (JPEG, PNG o WebP, nome del campo qualsiasi) e i campi del template:
  `userid` (testo) e i cinque punteggi `total`, `technique`, `fun`, `style`, `performance` (numeri
  da 0 a 999), tutti **obbligatori** (altrimenti `400` con l'elenco di quelli mancanti); facoltativi
  `title` e `copies` (1–10)
- oppure **JSON** `{ "url": "https://.../foto.jpg", "userid": "Mario", "total": 87, "technique": 90,
  "fun": 95, "style": 78, "performance": 85 }`

Nel template i valori vanno nei testi segnaposto: `{name}` ← `userid` in maiuscolo, `{total}`,
`{technique}`, `{Fun}`, `{Style}`, `{Performance}` ← i punteggi, scritti con almeno due cifre (`09`),
con il font, la dimensione, il colore e l'allineamento del livello. Un valore troppo lungo viene
rimpicciolito per restare nel suo spazio.

Le foto finiscono in una coda. Sul PC collegato alla stampante gira il **servizio di stampa**,
che preleva le foto dal server: il PC fa solo chiamate in uscita, quindi funziona anche con il
server su AWS, senza aprire porte.

```sh
npm run print -- --printers   # elenca le stampanti di questo PC
npm run print                 # avvia il servizio
```

Per ogni foto il servizio la unisce al template PSD (il `.psd` più recente in `templates/`, la foto
va al posto del livello `card`: vedi `templates/README.md`), lo manda al server come anteprima
e lo stampa su `PRINTER_NAME`, che può essere qualsiasi stampante installata in Windows, anche USB
(`npm run print -- --printers` segna quelle USB). Senza stampante configurata salva solo i file.

L'**anteprima di stampa** si vede su `http://<server>/<evento>/print` (link «Anteprima stampe»
nell'admin): l'ultima foto composta in grande con lo stato di stampa, le precedenti di lato; si
aggiorna da sola. Come il wall è in sola lettura e non chiede la chiave. A ogni nuova stampa (anche
una ristampa) si apre una **finestra di stampa classica**: il foglio con la foto composta e le
impostazioni (stampante, copie, formato carta, orientamento). Con la stampante collegata si chiude
da sola 1,5 secondi dopo l'avvio della stampa; senza stampante, o in caso di errore, resta aperta
finché non la si chiude («Chiudi», Esc o clic fuori).
Nell'admin si vede se il servizio è collegato, lo stato di ogni foto (in coda, in stampa,
stampata, salvata, errore) e si può ristampare. Con l'evento spento la coda è in pausa.

Configurazione nel `.env` del PC di stampa: `PHOTOBOOTH_API_KEY` (la stessa del server),
`PRINT_SERVER_URL`, `PRINTER_NAME`, `PRINT_PAPER_SIZE` (formato del driver se l'evento non ne
indica uno), `PRINT_TEMPLATE`, `PRINT_PHOTO_LAYER`,
`PRINT_OUTPUT_DIR`, `PRINT_POLL_SECONDS`.

Gli URL di Replicate (`replicate.delivery`) scadono dopo circa un'ora: n8n deve mandare la foto
subito dopo averla generata, oppure inviarla come file.

## Email

Un account SMTP per il server (admin, tab «Email») e un modello HTML per evento, caricato con le
sue immagini (admin, evento, «Email»). n8n chiama `POST http://localhost:80/<evento>/mail` con la
chiave, in Form-Data o JSON:

- obbligatori: `to`, `subject` (l'oggetto, anche con `{segnaposto}`), `userid` (nome e cognome),
  `link` (la pagina EDS costruita nel flusso) e `card` (la card generata col PSD: file, oppure il
  suo URL nel campo `card`)
- facoltativi: `cc`, `bcc`; gli altri campi riempiono gli altri `{segnaposto}` del modello

Nel modello: `{userid}`, `<a href="{link}">`, `<img src="{card}">`. La card è nel testo e anche
allegata. Destinatari, valori e card non vengono salvati. Risposte: `200` con `missing` (i
segnaposto rimasti vuoti); `400` campo mancante o non valido; `409` evento spento, senza modello o
account non configurato; `502` rifiuto del server SMTP.

## API

| Metodo e percorso | Chiave | |
|---|---|---|
| `GET /api/events` | sì | elenco eventi con video |
| `POST /api/events` `{name, slug?}` | sì | crea evento |
| `PATCH /api/events/<evento>` `{active?, name?}` | sì | accendi/spegni, rinomina |
| `DELETE /api/events/<evento>` | sì | elimina evento e video |
| `DELETE /api/events/<evento>/videos/<id>` | sì | elimina un video |
| `GET /<evento>/wall` | no | pagina del wall |
| `POST /<evento>/wall` (o `/api/events/<evento>/videos`) | sì | invio video (n8n) |
| `GET /api/events/<evento>/wall` | no | stato e playlist del wall |
| `GET /api/events/<evento>/live` (WebSocket) | no | aggiornamenti in diretta `{type, data}`: `status`, `video`, `removed`, `print`, `print-removed` |
| `GET /api/events/<evento>/stream` | no | gli stessi aggiornamenti in SSE (compatibilità) |
| `DELETE /api/events/<evento>/videos` | sì | elimina tutti i video |
| `DELETE /api/events/<evento>/photos` | sì | elimina tutte le foto (e le anteprime) |
| `GET /media/<evento>/<file>` | no | file video (con Range) |
| `GET /<evento>/print` | no | pagina delle stampe |
| `POST /<evento>/print` (o `/api/events/<evento>/photos`) | sì | foto da stampare (n8n) |
| `POST /api/events/<evento>/photos/<id>/reprint` | sì | rimette in coda |
| `DELETE /api/events/<evento>/photos/<id>` | sì | elimina una foto |
| `GET /api/print/queue` | sì | foto in attesa (servizio di stampa) |
| `POST /api/print/photos/<id>/claim` | sì | presa in carico |
| `GET /api/print/photos/<id>/file` | sì | file della foto |
| `POST /api/print/photos/<id>/preview` (image/jpeg) | sì | anteprima composta |
| `POST /api/print/photos/<id>/result` `{ok, printed?, error?}` | sì | esito della stampa |
| `GET /api/events/<evento>/prints` | no | anteprime per la pagina `/<evento>/print` |
| `PATCH /api/events/<evento>` `{printSettings}` | sì | impostazioni di stampa dell'evento |
| `PATCH /api/events/<evento>` `{showPlaceholder}` | sì | card di esempio sul wall |
| `POST /<evento>/mail` (o `/api/events/<evento>/mail`) | sì | invio mail (n8n) |
| `GET /api/health` | no | `{"ok":true}` se il server risponde |

«sì» = chiave API oppure console. Solo console (login): `POST /api/admin/login` `{user, password}`,
`POST /api/admin/logout`, `GET /api/admin/session`, `GET /api/admin/api-key`, `GET /api/info`,
`/api/mail/config`, `/api/mail/verify`, `/api/mail/test`, `/api/events/<evento>/mail-template…`,
`/api/events/<evento>/template…` (caricamento e anteprima), `/api/logs…`.

## Test

```sh
npm test
```
