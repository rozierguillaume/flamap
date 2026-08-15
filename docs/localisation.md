# Localisation

Le bouton « Ma position » utilise l’API de géolocalisation du navigateur. Il
ne demande l’autorisation qu’après un clic, puis centre la carte sur la
position reçue avec un niveau de zoom minimal de 11.

## Tester en local

Depuis la racine du dépôt :

```bash
python3 scripts/serve_no_cache.py --port 8777
```

Ouvrir ensuite <http://127.0.0.1:8777/>. Une adresse `localhost` convient aussi.
Il ne faut pas ouvrir `index.html` directement avec `file://` : les données
statiques ne seraient pas chargées correctement.

## Autorisations sur macOS

Deux autorisations peuvent intervenir :

1. l’autorisation du site dans le navigateur ;
2. l’autorisation du navigateur dans macOS.

Dans **Réglages Système → Confidentialité et sécurité → Service de
localisation**, activer le service et autoriser Safari ou Google Chrome. Dans
le navigateur, vérifier également que la localisation est autorisée pour
`127.0.0.1` ou `localhost`.

Le navigateur peut être autorisé tout en ne renvoyant aucune position si le
service macOS est désactivé. Flamap affiche alors un diagnostic invitant à
vérifier ce réglage.

## Cas dégradés

- un refus de permission est signalé et les nouvelles demandes sont bloquées ;
- une position indisponible renvoie vers les réglages macOS ;
- une recherche trop longue peut être relancée avec le bouton ;
- les navigateurs sans API de géolocalisation affichent un message explicite.

Les coordonnées ne sont pas envoyées à Flamap : elles servent uniquement à
déplacer la carte dans le navigateur.
