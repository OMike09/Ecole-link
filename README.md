# 🟠 ÉCOLE LINK — le pont école ↔ parents

Application PWA : l'école pointe les présences et parle aux parents (convocations, urgences, nouvelles) ; les parents reçoivent tout, déclarent les maladies, suivent et s'abonnent (**3 000 F/an par famille** — 30 jours d'essai offerts).

## Architecture (batterie éprouvée)

| Pièce | Fichier |
|---|---|
| Serveur Node (API + WebSocket maison + push VAPID + base `db.json`) | `server.js` |
| Application parents (PWA installable, thème orange) | `index.html` |
| Portail école + plateforme PDG (volets pliables) | `admin.html` |
| Notifications « poche » (push + cache doux) | `sw.js` + `manifest.json` |
| Logo / icônes | `logo-ecole-link.png`, `ecole-link-icon-192.png`, `ecole-link-icon-512.png` |

Dépendance unique : `web-push` (optionnelle — sans elle, tout marche sauf les notifications application fermée).

## Lancer

```bash
npm install   # ou laisser Render le faire (il lance npm start tout seul)
npm start     # http://localhost:8080
```

| Adresse | Pour qui |
|---|---|
| `/` | Les parents (inscription, 30 jours d'essai) |
| `/admin` | 🏫 école (onglet « Je suis de l'école ») · 👑 plateforme (onglet PDG) |

## Cérémonie du premier démarrage

1. `/admin` → onglet **Plateforme** → « ⛏️ Initialiser le mot de passe maître » (PDG)
2. Panneau **🏫 Écoles** → ajouter l'école pilote (ex : *Collège Moderne de Bouaké*)
3. Panneau **🧑‍🏫 Comptes guidés** → créer le directeur : mot de passe généré, **remis en main propre** (affiché une fois)
4. Le directeur se connecte (onglet « Je suis de l'école ») → crée ses classes → inscrit les élèves : chaque élève reçoit un **code famille à 6 chiffres** à remettre aux parents (WhatsApp/papier)
5. Les parents installent l'app (`/`), s'inscrivent, touchent **➕ Lier un enfant** avec le code — le pont est bâti 🤝

## Le circuit, tel qu'il est testé de bout en bout ✔

- ✅ Pointage du matin → les parents des absents reçoivent l'alerte 🚨 **à la minute**
- 🤒 Parent déclare une maladie (photo du certificat) → l'école valide → parent prévenu ✅
- 📅 Convocation avec **« Je viens / Je ne viens pas »** → compteurs oui/non chez le directeur (+ accusés de lecture)
- 🧡 Paiement 3 000 F (Wave/OM/MTN, référence copiée) → validation par le PDG → **1 an d'abonnement**, famille entière

## Déploiement (Render, comme KLEAN)

1. Créer le dépôt vide `ecole-link` (public ou privé) sur votre GitHub
2. Pousser ce dossier à la racine
3. Render → **New → Web Service** → ce dépôt → plan Free → `Auto-Deploy`
4. Build command : `npm install` · Start : `node server.js`
5. Domaine fourni par Render → c'est en l'air ; crée&grave;z ensuite le mot de passe maître sur `/admin`
