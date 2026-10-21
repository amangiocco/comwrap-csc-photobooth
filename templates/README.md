Il modo più comodo è caricare il template dall'admin («Template di stampa» dell'evento): vale
subito e il servizio di stampa lo scarica da solo. Questa cartella serve per gli eventi che non
ne hanno uno caricato.

Metti qui il template di stampa (un file `.psd`): il servizio di stampa usa il PSD più recente di
questa cartella e se ne accorge da solo quando lo sostituisci. Per usare un file preciso indica il
percorso con `PRINT_TEMPLATE` nel file `.env`.

La foto va al posto del livello **card** (oppure **FOTO**; altri nomi con `PRINT_PHOTO_LAYER`):
riempie il riquadro del livello dentro il foglio (ritagliata se le proporzioni sono diverse, tenendo
la parte più interessante) e prende la sua maschera di livello. Il foglio stampato ha dimensioni e
risoluzione del PSD.

Se il livello della foto è **nascosto e sotto non c'è niente di visibile** (com'è nel template
Comwrap), sopra la foto va l'immagine composita che Photoshop salva nel PSD: sfumature, effetti e
metodi di fusione escono identici a Photoshop. Per questo il PSD va salvato con «Massimizza
compatibilità» attivo (è il default) e con il livello `card` nascosto.

Altrimenti i livelli vengono ridisegnati uno per uno: in quel caso effetti, metodi di fusione
diversi da «Normale», livelli di riempimento e di regolazione non vengono riprodotti, e
`npm run print` lo segnala all'avvio.

## Testi variabili

I livelli di testo con il nome tra graffe sono **segnaposto**: `{name}` riceve lo `userid` della
chiamata (in maiuscolo), `{total}`, `{technique}`, `{Fun}`, `{Style}`, `{Performance}` i punteggi.
Vengono riscritti con font, dimensione, colore, crenatura, allineamento e rotazione del livello;
la posizione è tarata sul testo di esempio del PSD («NAME», «01»).

Due condizioni:

1. **I livelli segnaposto vanno nascosti** (occhio spento) prima di salvare il PSD, altrimenti il
   loro testo di esempio finisce nella composita e si vede sotto quello vero.
2. **I font del PSD** vanno messi nella cartella `templates/fonts/` (file `.otf` o `.ttf`; il nome
   del file non conta). Per il template Comwrap servono `Alaska-ExtraCondBlackIta` (numeri) e
   `Alaska-XCnBlkItContrast` (nome). Se mancano si usa Impact e `npm run print` lo segnala.
