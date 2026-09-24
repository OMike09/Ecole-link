# 📘 KLEAN — Guide propriétaire : comment tout fonctionne (version simple)

## 1. Trois espaces (vous en avez déjà 2 sur 3)
- **App** `klean-4cjj.onrender.com` → Clients + Agents (même appli, interfaces différentes)
- **HQ** `/admin` → vous aujourd'hui (propriétaire) · les admins terrain viendront plus tard
- Les **données** vivent dans la base Neon (Postgres) — jamais dans l'appli. L'appli peut se redéployer 100 fois sans perdre une donnée.

## 2. Cycle d'une mission (ce que chacun voit)
1. Client **inscrit** (obligatoire depuis lot 3) choisit service → description → date/quartier → prix estimé.
2. La demande est **diffusée à tous les agents "En ligne"**. Sans agent en ligne → elle part en attente → après ~45 s le client est invité à réessayer (annulation auto propre).
3. Un agent accepte → il voit le nom, la position GPS, le prix, les photos.
4. Étapes : 🛵 En route → 📍 Arrivé → 🧽 En cours → ✅ Terminée.
5. Paiement (Wave/Moov/Orange/espèces — virement manuel aux numéros affichés), puis le client note ⭐.
6. Votre HQ : l'agent garde 75 % → vous touchez 25 % (modifiable par vous).

## 3. Agents : de l'inscription à la mission
- Dossier complet (identité, pièce, réfs, services, **niveau d'étude si cours 📚**) → statut 🟡 pending.
- **Vous décidez** : ✅ Valider / ✕ Rejeter (motif) / 📝 Demander des infos (motif → l'agent renvoie un dossier corrigé).
- L'historique est gardé (quoi, quand) → panneau HQ + journal d'audit.

## 4. Pourquoi l'appli "met des lignes" au démarrage ?
Render gratuit **endort** le serveur après ~15 min sans visite. Au 1ᵉʳ clic, il se réveille : ~50 s d'attente (et la bannière Render dans votre dashboard). **Remède** : un service de ping (UptimeRobot / cron-job.org, gratuit) qui appelle `/api/health` toutes les 5 min → serveur toujours chaud, ouverture immédiate.

## 5. Règles mémo importantes
- **Une mission terminée ou annulée ne compte plus** dans les 3 simultanées. Les "disparues" = en général des demandes expirées (aucun agent en ligne à ce moment) ou un redémarrage pile pendant l'écriture (corrigé par sauvegarde SIGTERM du lot 3).
- Les inscriptions sont **réelles** : le compteur "👥 Clients inscrits" en haut du HQ lit la base en direct.
- Les données du HQ = **toujours calculées depuis la base**, jamais inventées.

## 6. Votre mot de passe propriétaire
- Il est **chiffré** : personne ne peut le relire (même pas vous) ; on ne peut que le réinitialiser.
- Création demandée **une seule fois** (après la réinitialisation de sécurité). Ensuite : connexion simple.
- "Mot de passe oublié ?" → via `ADMIN_RESET_CODE` sur Render (à usage unique).
- 6 échecs de connexion IP → bloquée 10 min (protégé).

## 7. Villes et quartiers
- 5 villes "officielles" avec quartiers suggérés (Bouaké, Abidjan, Yamoussoukro, Touba, Kounahiri).
- + **toutes les autres villes de Côte d'Ivoire** sélectionnables (quartier tapé à la main).
- + **saisie libre** : le client peut taper n'importe quelle ville inconnue.

## 8. SMS (en attente Orange)
L’envoi SMS **KLEAN-SV CI** est retiré de l’appli le temps qu’Orange **whitelist** le sender. Les hors ligne reçoivent encore l’alerte **poche**. On réactivera le SMS dès l’e-mail Orange.

## 9. La boucle de mise à jour (à mémoriser)
1. Vous décrivez le changement → 2. je le construis et teste → 3. dossier **A_ENVOYER N** (règle : toujours le numéro le plus grand) → 4. upload GitHub → 5. Render redéploie (~3 min) → 6. je vérifie à distance.

## 9. Sécurité déjà en place
- Mots de passe clients & HQ hashés (chiffrés) · déconnexions possibles · missions attachées au client · agents validés par vous seul · journal d'audit inviolable par tiers.
