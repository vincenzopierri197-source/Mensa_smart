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

I dati sono associati a una sessione Firebase Authentication anonima e sincronizzati con Cloud Firestore nel documento `users/{uid}`. Una copia locale viene mantenuta nel browser per continuità e supporto offline limitato. La sessione anonima persiste sullo stesso browser; non identifica la stessa persona su un dispositivo diverso. Per trasferire i dati su un altro browser o dispositivo, usa **Backup** e salva il file JSON, poi accedi alla nuova sessione anonima e usa **Ripristina**. Il backup può contenere informazioni sulle presenze e sui pagamenti: conservalo in un luogo sicuro.

## Pubblicazione su GitHub Pages

1. Crea un repository GitHub e carica i file di questo progetto.
2. Nel repository apri **Settings → Pages**.
3. In **Build and deployment**, seleziona **Deploy from a branch**, scegli `main` e la cartella `/ (root)`, poi salva.
4. Apri l'indirizzo Pages mostrato da GitHub.

La pubblicazione contiene l'applicazione, non i dati personali. Ogni sessione anonima Firebase accede esclusivamente al proprio documento Firestore, secondo le regole definite in `firestore.rules`.

## File del progetto

- `index.html` — struttura dell'interfaccia
- `style.css` — stile e layout
- `app.js` — logica dell'app, autenticazione anonima e sincronizzazione Firestore
- `firestore.rules` — regole di accesso ai dati per singolo UID anonimo
