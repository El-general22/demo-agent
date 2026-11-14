# Agent conversationnel (démo)

Page web qui permet à chaque utilisateur de discuter avec un modèle de langage
en apportant **sa propre clé API** et **son fournisseur** : ChatGPT, Claude,
Gemini ou Groq (Groq est présélectionné), ou « Autre » pour tout service
compatible OpenAI.

- Le **modèle est facultatif** : laissé vide, l'application en choisit un qui fonctionne.
  S'il est renseigné, il est utilisé tel quel.
- La clé est saisie dans la page et reste dans le navigateur (jamais dans ces fichiers).
- Firestore est facultatif : renseigner `firebase-config.js` pour l'activer.
- Fichiers : `index.html`, `app.js`, `firebase-config.js`, `firestore.rules`.

Démo pédagogique : ne saisissez aucune donnée personnelle ou confidentielle.
