# Gestione Mensa Pro

Applicazione web per registrare i pasti in mensa, i pagamenti e i buoni pasto, con riepiloghi mensili e annuali.

## Avvio

Apri `index.html` con un browser moderno. Non servono installazioni, server o dipendenze esterne.

## Funzioni

- Conteggio di pranzi e cene per giorno e mese
- Calcolo di importi, pagamenti e saldi riportati tra i mesi
- Conteggio e valorizzazione dei buoni pasto
- Esportazione del riepilogo in CSV, apribile con Excel
- Backup e ripristino dei dati in formato JSON
- Stampa del riepilogo

## Dati e backup

I dati vengono salvati nel `localStorage` del browser e non sono sincronizzati automaticamente tra dispositivi. Per conservare o trasferire i dati, usa **Backup** e salva il file JSON; per importarli su un altro browser usa **Ripristina**. Conserva il backup in un luogo sicuro: può contenere informazioni sulle presenze e sui pagamenti.

## Pubblicazione su GitHub Pages

1. Crea un repository GitHub e carica i file di questo progetto.
2. Nel repository apri **Settings → Pages**.
3. In **Build and deployment**, seleziona **Deploy from a branch**, scegli `main` e la cartella `/ (root)`, poi salva.
4. Apri l'indirizzo Pages mostrato da GitHub.

La pubblicazione contiene l'applicazione, non i dati salvati nel browser. Chiunque abbia accesso al sito può usare la propria copia dell'app; i dati restano nel browser di ciascun visitatore.

## File del progetto

- `index.html` — struttura dell'interfaccia
- `style.css` — stile e layout
- `app.js` — logica dell'app e persistenza locale
