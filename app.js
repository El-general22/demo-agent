// Agent conversationnel : chaque utilisateur apporte sa clé API et son fournisseur.
// La clé n'est JAMAIS écrite dans un fichier : elle reste dans le navigateur de l'utilisateur.
// firebase-config.js est facultatif : s'il manque ou est cassé, l'agent fonctionne quand même
let firebaseConfig = null;
try { firebaseConfig = (await import("./firebase-config.js")).firebaseConfig; } catch { /* Firestore désactivé */ }

const FIREBASE_VERSION = "12.0.0"; // à aligner avec la version affichée par la console Firebase
const SDK = "https://www.gstatic.com/firebasejs/" + FIREBASE_VERSION + "/";

// ---------------------------------------------------------------
// 1. Les fournisseurs proposés
//    type "openai"    : format compatible OpenAI (ChatGPT, Groq...)
//    type "anthropic" : API Messages d'Anthropic (Claude)
//    type "gemini"    : API native de Google (Gemini)
//    defauts : modèles essayés dans l'ordre quand l'utilisateur n'en indique pas
//    liste   : adresse qui énumère les modèles disponibles (dernier recours)
//    prefere / exclure : filtres pour choisir un modèle dans cette liste
// ---------------------------------------------------------------
const GEMINI = "https://generativelanguage.googleapis.com/v1beta";
const FOURNISSEURS = {
  chatgpt: {
    nom: "ChatGPT (OpenAI)", type: "openai",
    url: "https://api.openai.com/v1/chat/completions", liste: "https://api.openai.com/v1/models",
    defauts: ["gpt-4o-mini", "gpt-4.1-mini"],
    inclure: /^gpt-/, prefere: /mini/, exclure: /(audio|realtime|image|tts|transcribe|search|instruct|embedding|moderation|codex|preview)/,
    cleUrl: "https://platform.openai.com/api-keys",
  },
  claude: {
    nom: "Claude (Anthropic)", type: "anthropic",
    url: "https://api.anthropic.com/v1/messages", liste: "https://api.anthropic.com/v1/models",
    defauts: ["claude-haiku-5-5", "claude-sonnet-5-5"],
    inclure: /^claude-/, prefere: /haiku/, exclure: /(deprecated)/,
    cleUrl: "https://console.anthropic.com/settings/keys",
    note: "Clé personnelle uniquement : l'appel direct depuis un navigateur est réservé à un usage individuel.",
  },
  gemini: {
    nom: "Gemini (Google)", type: "gemini",
    url: GEMINI, liste: GEMINI + "/models",
    defauts: ["gemini-2.0-flash", "gemini-2.5-flash", "gemini-flash-latest"],
    inclure: /^gemini-/, prefere: /flash/, exclure: /(image|tts|embedding|live|audio|thinking|exp|preview|vision)/,
    cleUrl: "https://aistudio.google.com/apikey",
  },
  groq: {
    nom: "Groq", type: "openai",
    url: "https://api.groq.com/openai/v1/chat/completions", liste: "https://api.groq.com/openai/v1/models",
    defauts: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "openai/gpt-oss-20b"],
    inclure: /(llama|gpt-oss)/, prefere: /(versatile|instant|gpt-oss)/, exclure: /(whisper|guard|tts|vision|compound)/,
    cleUrl: "https://console.groq.com/keys",
  },
  autre: {
    nom: "Autre (compatible OpenAI)", type: "openai", url: "", defauts: [],
    note: "Indiquez l'adresse complète de l'API (se terminant souvent par /chat/completions) et le nom du modèle.",
  },
};
const FOURNISSEUR_PAR_DEFAUT = "groq";

const ROLE_PAR_DEFAUT = "Tu es un assistant utile et clair. Tu réponds en français, de façon concise.";
const MAX_MESSAGES = 20; // taille de la mémoire envoyée au modèle

const el = (id) => document.getElementById(id);

// ---------------------------------------------------------------
// 2. Stockage local (try/catch : certains navigateurs bloquent le stockage)
// ---------------------------------------------------------------
const lire = (stock, k) => { try { return stock.getItem(k); } catch { return null; } };
const ecrire = (stock, k, v) => { try { stock.setItem(k, v); } catch { /* ignoré */ } };
const retirer = (stock, k) => { try { stock.removeItem(k); } catch { /* ignoré */ } };

const lireCle = () => lire(sessionStorage, "agent_cle") || lire(localStorage, "agent_cle") || "";
function sauverCle(cle, memoriser) {
  retirer(localStorage, "agent_cle");
  retirer(sessionStorage, "agent_cle");
  ecrire(memoriser ? localStorage : sessionStorage, "agent_cle", cle);
}
function oublierCle() { retirer(localStorage, "agent_cle"); retirer(sessionStorage, "agent_cle"); }

// ---------------------------------------------------------------
// 3. Interface : connexion
// ---------------------------------------------------------------
let historique = []; // messages {role, content} de la conversation en cours

function remplirFournisseurs() {
  const alerte = document.getElementById("alerte-script"); if (alerte) alerte.remove();
  el("fournisseur").replaceChildren();
  Object.entries(FOURNISSEURS).forEach(([id, f]) => {
    const o = document.createElement("option");
    o.value = id; o.textContent = f.nom;
    el("fournisseur").appendChild(o);
  });
}

function appliquerFournisseur() {
  const f = FOURNISSEURS[el("fournisseur").value];
  el("bloc-url").hidden = el("fournisseur").value !== "autre";
  const aide = el("note-fournisseur");
  aide.replaceChildren();
  if (f.note) aide.append(f.note + " ");
  if (f.cleUrl) {
    const a = document.createElement("a");
    a.href = f.cleUrl; a.target = "_blank"; a.rel = "noopener noreferrer";
    a.textContent = "Où trouver ma clé ?";
    aide.append(a);
  }
}

function statut(msg, erreur = false) {
  el("statut").textContent = msg;
  el("statut").className = "aide" + (erreur ? " erreur" : "");
}

function urlValide(u) {
  try {
    const x = new URL(u);
    return x.protocol === "https:" || (x.protocol === "http:" && x.hostname === "localhost");
  } catch { return false; }
}

function config() {
  const sauve = lire(localStorage, "agent_fournisseur");
  const id = FOURNISSEURS[sauve] ? sauve : FOURNISSEUR_PAR_DEFAUT;
  const f = FOURNISSEURS[id];
  return {
    id, f, type: f.type, nom: f.nom,
    url: id === "autre" ? (lire(localStorage, "agent_url") || "") : f.url,
    modele: lire(localStorage, "agent_modele") || "", // vide = choix automatique
  };
}

function majResume(modeleUtilise) {
  const c = config();
  el("resume-connexion").textContent = c.nom + " · " + (modeleUtilise || c.modele || "modèle automatique");
}

function connecter() {
  const id = el("fournisseur").value;
  const modele = el("modele").value.trim();
  const cle = el("cle").value.trim() || lireCle();
  const url = el("url").value.trim();

  if (!cle) return statut("Collez d'abord votre clé API.", true);
  if (!/^[\x21-\x7E]+$/.test(cle)) return statut("La clé contient un caractère inattendu (espace, retour à la ligne, accent). Recopiez-la entière.", true);
  if (id === "autre") {
    if (!urlValide(url)) return statut("L'adresse de l'API doit commencer par https://", true);
    if (!modele) return statut("Pour ce fournisseur, indiquez le nom du modèle.", true);
  }

  ecrire(localStorage, "agent_fournisseur", id);
  ecrire(localStorage, "agent_modele", modele);
  if (id === "autre") ecrire(localStorage, "agent_url", url);
  sauverCle(cle, el("memoriser").checked);
  el("cle").value = ""; // on ne laisse pas la clé affichée dans le champ
  statut("");
  afficherChat();
}

function afficherChat() {
  const c = config();
  majResume();
  etatBarre(true, c.nom);
  el("config").hidden = true;
  el("chat").hidden = false;
  majVide();
  if (!el("role").value) el("role").value = ROLE_PAR_DEFAUT;
  el("question").focus();
}

function afficherConfig() {
  const c = config();
  el("fournisseur").value = c.id;
  appliquerFournisseur();
  el("modele").value = c.modele;
  el("url").value = c.id === "autre" ? c.url : "";
  el("cle").placeholder = lireCle() ? "Laisser vide pour garder la clé actuelle" : "Collez votre clé ici";
  el("config").hidden = false;
  el("chat").hidden = true;
  etatBarre(false);
}

function etatBarre(connecte, nom) {
  el("etat-barre").textContent = connecte ? "Connecté · " + nom : "Non connecté";
  el("etat-barre").classList.toggle("connecte", connecte);
}

// ---------------------------------------------------------------
// 4. Appel du modèle (fetch) : adresse + badge (clé) + contenu (JSON)
// ---------------------------------------------------------------
function messageErreur(status, texte, cle) {
  const brut = String(texte || "").split(cle).join("***").slice(0, 200); // jamais la clé à l'écran
  if (status === 401 || status === 403) return "Clé refusée (" + status + "). Vérifiez la clé et le fournisseur choisi.";
  if (status === 404) return "Modèle ou adresse introuvable (404).";
  if (status === 429) return "Trop de requêtes (429) ou quota atteint. Attendez une minute.";
  return "Erreur " + status + (brut ? " : " + brut : "");
}

async function appel(url, options) {
  const stop = new AbortController();
  const delai = setTimeout(() => stop.abort(), 60000);
  try {
    return await fetch(url, { ...options, signal: stop.signal });
  } catch (e) {
    throw new Error(e.name === "AbortError"
      ? "Le fournisseur met trop de temps à répondre. Réessayez."
      : "Impossible de joindre le fournisseur (réseau, adresse incorrecte ou accès refusé au navigateur).");
  } finally { clearTimeout(delai); }
}

// En-têtes propres à chaque fournisseur (la clé est le « badge »)
function entetes(c, cle) {
  if (c.type === "anthropic") return { "Content-Type": "application/json", "x-api-key": cle, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" };
  if (c.type === "gemini") return { "Content-Type": "application/json", "x-goog-api-key": cle };
  return { "Content-Type": "application/json", "Authorization": "Bearer " + cle };
}

// Un essai avec un modèle précis. Renvoie { ok, texte } ou { ok:false, status, erreur }
async function tenter(c, modele, messages, role, cle) {
  let url = c.url, body;
  if (c.type === "anthropic") {
    body = { model: modele, max_tokens: 1024, system: role, messages };
  } else if (c.type === "gemini") {
    url = GEMINI + "/models/" + encodeURIComponent(modele) + ":generateContent";
    body = {
      systemInstruction: { parts: [{ text: role }] },
      contents: messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
    };
  } else {
    body = { model: modele, messages: [{ role: "system", content: role }, ...messages] };
  }

  const res = await appel(url, { method: "POST", headers: entetes(c, cle), body: JSON.stringify(body) });
  if (!res.ok) return { ok: false, status: res.status, erreur: messageErreur(res.status, await res.text().catch(() => ""), cle) };

  const data = await res.json().catch(() => null);
  let texte;
  if (c.type === "anthropic") texte = data && data.content && data.content[0] && data.content[0].text;
  else if (c.type === "gemini") {
    const parts = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
    texte = parts && parts.map((p) => p.text || "").join("");
  } else texte = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!texte) return { ok: false, status: 200, erreur: "Réponse vide ou bloquée par le fournisseur." };
  return { ok: true, texte };
}

// Dernier recours : demander au fournisseur la liste de ses modèles et en choisir un
async function modelesDisponibles(c, cle) {
  if (!c.f.liste) return [];
  const res = await appel(c.f.liste, { method: "GET", headers: entetes(c, cle) });
  if (!res.ok) return [];
  const data = await res.json().catch(() => null);
  const brut = data && (data.data || data.models) || [];
  const ids = brut
    .filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes("generateContent"))
    .map((m) => String(m.id || m.name || "").replace(/^models\//, ""))
    .filter((id) => id && c.f.inclure.test(id) && !c.f.exclure.test(id));
  return ids.sort((a, b) => Number(c.f.prefere.test(b)) - Number(c.f.prefere.test(a)));
}

async function appelerLLM(messages) {
  const c = config();
  const cle = lireCle();
  if (!cle) throw new Error("Aucune clé enregistrée. Cliquez sur « Modifier la connexion ».");
  const role = el("role").value.trim() || ROLE_PAR_DEFAUT;

  // Cas 1 : l'utilisateur a indiqué un modèle : on l'utilise tel quel
  if (c.modele) {
    const r = await tenter(c, c.modele, messages, role, cle);
    if (!r.ok) throw new Error(r.erreur + (r.status === 404 || r.status === 400 ? " Vérifiez le nom du modèle, ou videz le champ pour un choix automatique." : ""));
    return r.texte;
  }

  // Cas 2 : modèle facultatif laissé vide : on choisit pour lui
  const cleCache = "agent_auto_" + c.id;
  const memorise = lire(localStorage, cleCache);
  const essais = [...new Set([memorise, ...c.f.defauts].filter(Boolean))];
  let derniere = "";

  const essayer = async (modele) => {
    const r = await tenter(c, modele, messages, role, cle);
    if (r.ok) { ecrire(localStorage, cleCache, modele); majResume(modele); return r; }
    if (![400, 404, 422].includes(r.status)) throw new Error(r.erreur); // clé, quota, réseau : inutile d'insister
    if (modele === memorise) retirer(localStorage, cleCache);
    derniere = r.erreur;
    return null;
  };

  for (const modele of essais) { const r = await essayer(modele); if (r) return r.texte; }

  const decouverts = (await modelesDisponibles(c, cle).catch(() => [])).filter((m) => !essais.includes(m)).slice(0, 3);
  for (const modele of decouverts) { const r = await essayer(modele); if (r) return r.texte; }

  throw new Error("Aucun modèle utilisable n'a été trouvé automatiquement. Indiquez un nom de modèle dans « Modifier la connexion »." + (derniere ? " (" + derniere + ")" : ""));
}

// ---------------------------------------------------------------
// 5. Conversation
// ---------------------------------------------------------------
function bulle(type, texte) {
  const b = document.createElement("div");
  b.className = "bulle " + type;
  if (type === "utilisateur") b.dataset.auteur = "Vous";
  if (type === "assistant") b.dataset.auteur = "Agent";
  b.textContent = texte; // textContent, jamais innerHTML
  el("fil").appendChild(b);
  majVide();
  el("fil").scrollTop = el("fil").scrollHeight;
  return b;
}

// Affiche l'invitation et les suggestions tant que la conversation est vide
function majVide() { el("vide").hidden = el("fil").children.length > 0; }

async function envoyer(evt) {
  evt.preventDefault();
  const texte = el("question").value.trim();
  if (!texte) return;
  el("btn-envoyer").disabled = true;
  el("question").value = "";
  bulle("utilisateur", texte);
  historique.push({ role: "user", content: texte });
  const attente = bulle("attente", "L'agent réfléchit");

  try {
    let fenetre = historique.slice(-MAX_MESSAGES);
    while (fenetre.length && fenetre[0].role !== "user") fenetre = fenetre.slice(1);
    const reponse = await appelerLLM(fenetre);
    attente.remove();
    bulle("assistant", reponse);
    historique.push({ role: "assistant", content: reponse });
    if (el("sauvegarde").checked) await sauvegarder(texte, reponse);
  } catch (e) {
    attente.remove();
    if (historique.length && historique[historique.length - 1].role === "user") historique.pop();
    bulle("erreur", e.message);
  } finally {
    el("btn-envoyer").disabled = false;
    el("question").focus();
  }
}

function nouvelleConversation() {
  historique = [];
  el("fil").replaceChildren();
  majVide();
}

// ---------------------------------------------------------------
// 6. Firestore (facultatif) : chargé seulement si firebase-config.js est rempli
// ---------------------------------------------------------------
const firebaseActif = !!(firebaseConfig && firebaseConfig.projectId
  && !/^(COLLER|VOTRE)/.test(firebaseConfig.apiKey + firebaseConfig.projectId));
let fb = null;

async function firebase() {
  if (fb) return fb;
  const [appMod, fsMod] = await Promise.all([import(SDK + "firebase-app.js"), import(SDK + "firebase-firestore.js")]);
  fb = { db: fsMod.getFirestore(appMod.initializeApp(firebaseConfig)), ...fsMod };
  return fb;
}

async function sauvegarder(question, answer) {
  try {
    const f = await firebase();
    await f.addDoc(f.collection(f.db, "conversations"), {
      question: question.slice(0, 3900),
      answer: answer.slice(0, 7900),
      createdAt: f.serverTimestamp(),
    });
    await chargerHistorique();
  } catch (e) {
    bulle("erreur", "Firestore n'a pas enregistré l'échange. Vérifiez les règles et la configuration (" + (e.code || e.message) + ").");
  }
}

async function chargerHistorique() {
  const f = await firebase();
  const snap = await f.getDocs(f.query(f.collection(f.db, "conversations"), f.orderBy("createdAt", "desc"), f.limit(5)));
  el("historique").replaceChildren();
  snap.forEach((d) => {
    const li = document.createElement("li");
    li.textContent = String(d.data().question).slice(0, 80) + " → " + String(d.data().answer).slice(0, 80);
    el("historique").appendChild(li);
  });
  el("historique-zone").hidden = false;
}

// ---------------------------------------------------------------
// 7. Démarrage
// ---------------------------------------------------------------
remplirFournisseurs();
el("fournisseur").value = config().id;
appliquerFournisseur();
el("modele").value = config().modele;
// Changer de fournisseur : on vide le modèle (choix automatique) pour ne pas garder celui d'un autre
el("fournisseur").onchange = () => { appliquerFournisseur(); el("modele").value = ""; };
el("btn-connecter").onclick = connecter;
el("btn-oublier").onclick = () => { oublierCle(); etatBarre(false); el("cle").value = ""; el("cle").placeholder = "Collez votre clé ici"; statut("Clé effacée de ce navigateur."); };
el("btn-modifier").onclick = afficherConfig;
el("formulaire").onsubmit = envoyer;
el("btn-nouvelle").onclick = nouvelleConversation;
document.querySelectorAll(".suggestion").forEach((b) => {
  b.onclick = () => { el("question").value = b.textContent; el("question").focus(); };
});
el("question").onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); el("formulaire").requestSubmit(); } };

if (firebaseActif) {
  el("bloc-firestore").hidden = false;
  el("sauvegarde").onchange = () => { if (el("sauvegarde").checked) chargerHistorique().catch(() => {}); };
}

if (lireCle()) afficherChat();
