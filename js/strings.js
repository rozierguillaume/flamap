/* =====================================================================
 * TEXTES — français et espagnol côte à côte
 *
 * Une entrée par clé, les deux langues dans le même objet : une traduction
 * manquante se voit à la lecture, et `tests/js/i18n.test.js` la refuse. Les
 * entrées à deux formes (`one` / `other`) sont choisies par `plural()`.
 *
 * Les champs `{nom}` sont substitués par `t()`. Ne jamais y injecter de HTML :
 * seules les clés lues par `data-i18n-html` en portent, et elles sont listées
 * telles quelles ici.
 *
 * Les statuts PSFDF (« Éteint », « Hors de contrôle »…) sont des *valeurs de
 * données*, pas des textes d'interface : ils arrivent du collecteur, servent de
 * filtre MapLibre et de clé de couleur. Ils ne sont traduits qu'à l'affichage,
 * par les clés `status.*`.
 * ===================================================================== */
export const STRINGS = {

  /* ---------- en-tête du document et référencement ---------- */
  'app.title': {
    fr: 'Incendies en France et en Espagne : carte en quasi temps réel | Flamap',
    es: 'Incendios en España, Portugal y Francia: mapa casi en tiempo real | Flamap',
  },
  'app.description': {
    fr: 'Carte des incendies et feux de forêt en France, en Espagne et au Portugal : foyers actifs par satellite, surfaces brûlées, vent et évolution, mise à jour toutes les 30 minutes.',
    es: 'Mapa de incendios y fuegos forestales en España, Portugal y Francia: focos activos por satélite, superficies quemadas, viento y evolución, actualizado cada 30 minutos.',
  },
  'app.locale': { fr: 'fr_FR', es: 'es_ES' },
  'app.og.title': {
    fr: 'Incendies en France et en Espagne : la carte Flamap en quasi temps réel',
    es: 'Incendios en España, Portugal y Francia: el mapa Flamap casi en tiempo real',
  },
  'app.og.description': {
    fr: 'Suivez les foyers actifs détectés par satellite, les surfaces brûlées, le vent et l’évolution des feux en France et dans la péninsule Ibérique.',
    es: 'Sigue los focos activos detectados por satélite, las superficies quemadas, el viento y la evolución de los incendios en la península ibérica y en Francia.',
  },
  'app.tw.description': {
    fr: 'Foyers actifs par satellite, surfaces brûlées, vent et évolution des feux, mis à jour toutes les 30 min.',
    es: 'Focos activos por satélite, superficies quemadas, viento y evolución de los incendios, actualizados cada 30 min.',
  },
  'app.image.alt': {
    fr: 'Flamap, carte satellite des incendies en France et en Espagne.',
    es: 'Flamap, mapa satelital de los incendios en España, Portugal y Francia.',
  },

  /* ---------- structure de la page ---------- */
  'map.aria': {
    fr: 'Carte satellite des surfaces brûlées et des foyers d’incendie détectés',
    es: 'Mapa satelital de las superficies quemadas y de los focos de incendio detectados',
  },
  'map.unavailable': { fr: 'Carte indisponible', es: 'Mapa no disponible' },
  'map.controls.aria': { fr: 'Commandes de la carte', es: 'Controles del mapa' },
  'init.error': {
    fr: 'La carte n’a pas pu être chargée. Rechargez la page pour réessayer.',
    es: 'No se ha podido cargar el mapa. Recarga la página para volver a intentarlo.',
  },
  'init.failure': {
    fr: 'Initialisation de la carte impossible',
    es: 'No se ha podido inicializar el mapa',
  },
  'brand.sr': {
    fr: ' — carte des incendies en France et en Espagne en quasi temps réel',
    es: ' — mapa de incendios en España, Portugal y Francia casi en tiempo real',
  },
  'home.aria': {
    fr: 'Recentrer la carte sur la vue d’ensemble',
    es: 'Volver a centrar el mapa en la vista general',
  },
  'home.title': {
    fr: 'Recentrer sur la vue d’ensemble',
    es: 'Centrar en la vista general',
  },
  'location.aria': { fr: 'Me localiser', es: 'Localizarme' },
  'location.title': { fr: 'Utiliser ma position', es: 'Usar mi ubicación' },
  'location.title.denied': {
    fr: 'Localisation refusée — autorisez-la dans les réglages du navigateur',
    es: 'Localización rechazada — autorízala en los ajustes del navegador',
  },
  'location.btn.label': { fr: 'Ma position', es: 'Mi ubicación' },
  'location.loading': {
    fr: 'Recherche de votre position…',
    es: 'Buscando tu ubicación…',
  },
  'location.denied': {
    fr: 'Accès à la localisation refusé. Autorisez-la dans les réglages du navigateur puis réessayez.',
    es: 'Acceso a la localización rechazado. Autorízalo en los ajustes del navegador y vuelve a intentarlo.',
  },
  'location.unavailable': {
    fr: 'Votre position est momentanément indisponible.',
    es: 'Tu ubicación no está disponible por el momento.',
  },
  'location.system': {
    fr: 'Votre position n’a pas pu être déterminée. Vérifiez que les Services de localisation sont activés pour ce navigateur dans Réglages Système → Confidentialité et sécurité → Service de localisation.',
    es: 'No se ha podido determinar tu ubicación. Comprueba que los Servicios de localización están activados para este navegador en Ajustes del Sistema → Privacidad y seguridad → Servicios de localización.',
  },
  'location.timeout': {
    fr: 'La recherche de votre position a expiré. Réessayez.',
    es: 'La búsqueda de tu ubicación ha caducado. Vuelve a intentarlo.',
  },
  'location.unsupported': {
    fr: 'La localisation n’est pas disponible dans ce navigateur.',
    es: 'La localización no está disponible en este navegador.',
  },
  'location.invalid': {
    fr: 'Le navigateur a renvoyé une position invalide.',
    es: 'El navegador ha devuelto una ubicación no válida.',
  },
  'lang.aria': { fr: 'Ver Flamap en español', es: 'Voir Flamap en français' },
  'lang.code': { fr: 'ES', es: 'FR' },
  'notifications.title': { fr: 'Notifications', es: 'Notificaciones' },
  'notifications.intro': { fr: 'Recevez une alerte lorsqu’un nouveau foyer est publié près de vos adresses.', es: 'Recibe una alerta cuando se publique un nuevo foco cerca de tus direcciones.' },
  'notifications.empty': { fr: 'Aucune adresse enregistrée.', es: 'No hay direcciones registradas.' },
  'notifications.add': { fr: 'Ajouter une adresse', es: 'Añadir una dirección' },
  'notifications.address': { fr: 'Adresse en France', es: 'Dirección en Francia' },
  'notifications.search': { fr: 'Rechercher', es: 'Buscar' },
  'notifications.radius': { fr: 'Rayon autour de l’adresse', es: 'Radio alrededor de la dirección' },
  'notifications.confirm': { fr: 'Valider cette adresse', es: 'Confirmar esta dirección' },
  'notifications.choose': { fr: 'Choisissez d’abord une adresse.', es: 'Elige primero una dirección.' },
  'notifications.selected': { fr: 'Rayon choisi : activez les notifications.', es: 'Radio elegido: activa las notificaciones.' },
  'notifications.unsupported': { fr: 'Les notifications ne sont pas prises en charge par ce navigateur.', es: 'Este navegador no admite notificaciones.' },
  'notifications.denied': { fr: 'Autorisation refusée dans les réglages du navigateur.', es: 'Permiso rechazado en los ajustes del navegador.' },
  'notifications.enabled': { fr: 'Notifications activées.', es: 'Notificaciones activadas.' },
  'notifications.searchError': { fr: 'Adresse introuvable pour le moment.', es: 'No se encontró la dirección por el momento.' },
  'notifications.error': { fr: 'Impossible d’activer les notifications pour le moment.', es: 'No se pudieron activar las notificaciones por el momento.' },

  'intro.aria': { fr: 'Présentation de Flamap', es: 'Presentación de Flamap' },
  'intro.heading': {
    fr: 'Suivre les incendies et feux de forêt en cours en France et en Espagne',
    es: 'Seguir los incendios forestales activos en España, Portugal y Francia',
  },
  'intro.p1': {
    fr: 'Flamap est une carte des incendies mise à jour toutes les 30 minutes. Elle affiche les foyers actifs détectés par les satellites NASA FIRMS, les surfaces brûlées publiées par Copernicus EFFIS et le vent à 10 mètres, issu du modèle AROME de Météo-France sur la France et d’un modèle européen sur la péninsule Ibérique.',
    es: 'Flamap es un mapa de incendios actualizado cada 30 minutos. Muestra los focos activos detectados por los satélites NASA FIRMS, las superficies quemadas publicadas por Copernicus EFFIS y el viento a 10 metros, procedente del modelo AROME de Météo-France sobre Francia y de un modelo europeo sobre la península ibérica.',
  },
  'intro.p2': {
    fr: 'La frise temporelle permet de suivre l’évolution récente des feux, d’observer les passages satellite et de repérer les zones touchées. Les données sont publiques et la carte couvre la France métropolitaine et la Corse, l’Espagne continentale, les Baléares et le Portugal.',
    es: 'La línea de tiempo permite seguir la evolución reciente de los incendios, observar los pasos de los satélites y localizar las zonas afectadas. Los datos son públicos y el mapa cubre la España peninsular, las Baleares, Portugal, la Francia metropolitana y Córcega.',
  },
  'incidents.aria': {
    fr: 'Raccourcis vers les incendies importants',
    es: 'Accesos directos a los incendios importantes',
  },
  /* `<noscript>` reste en français : son contenu n'est pas analysé comme du DOM
   * quand les scripts sont actifs, et il n'est montré que lorsqu'ils ne le sont
   * pas — c'est-à-dire quand aucune traduction ne peut s'appliquer. */
  'common.close': { fr: 'Fermer', es: 'Cerrar' },

  /* ---------- panneau PSFDF ---------- */
  'psfdf.panel.title': {
    fr: 'Feux suivis par PSFDF',
    es: 'Incendios seguidos por PSFDF',
  },
  'psfdf.panel.sub': {
    fr: 'État actuel communiqué par l’association.',
    es: 'Estado actual comunicado por la asociación.',
  },
  'psfdf.panel.show': {
    fr: 'Afficher les détails du feu',
    es: 'Mostrar los detalles del incendio',
  },
  'psfdf.panel.hide': {
    fr: 'Masquer les détails du feu',
    es: 'Ocultar los detalles del incendio',
  },
  'psfdf.back.title': {
    fr: 'Revenir à la vue d’ensemble',
    es: 'Volver a la vista general',
  },
  'psfdf.back.aria': {
    fr: 'Retour à la vue d’ensemble',
    es: 'Volver a la vista general',
  },

  /* ---------- calques ---------- */
  'layers.aria': { fr: 'Calques', es: 'Capas' },
  'layers.psfdf': {
    fr: 'incendies signalés (PSFDF, détection auto)',
    es: 'incendios notificados (PSFDF, detección automática)',
  },
  'layers.hotspots': { fr: 'foyers détectés', es: 'focos detectados' },
  'layers.firms': { fr: 'Sources FIRMS', es: 'Fuentes FIRMS' },
  'layers.metric': {
    fr: 'Métrique des graphiques',
    es: 'Métrica de los gráficos',
  },
  'layers.metric.count': { fr: 'nombre de foyers', es: 'número de focos' },
  'layers.metric.frp': {
    fr: 'puissance radiative (MW)',
    es: 'potencia radiativa (MW)',
  },
  'layers.metric.frp.title': {
    fr: 'Somme de la puissance radiative instantanée des pixels détectés',
    es: 'Suma de la potencia radiativa instantánea de los píxeles detectados',
  },
  'layers.burnt.dated': {
    fr: 'surfaces brûlées (datées)',
    es: 'superficies quemadas (fechadas)',
  },
  'layers.burnt.nrt': {
    fr: 'surfaces brûlées (NRT)',
    es: 'superficies quemadas (NRT)',
  },
  'layers.smoke': {
    fr: 'panaches de fumée (simulés)',
    es: 'penachos de humo (simulados)',
  },
  'layers.smoke.title': {
    fr: 'Dispersion indicative calculée à partir des foyers FIRMS et du vent AROME',
    es: 'Dispersión orientativa calculada a partir de los focos FIRMS y del viento modelizado',
  },
  'layers.wind': { fr: 'vent à 10 m', es: 'viento a 10 m' },
  'layers.aircraft': { fr: 'moyens aériens', es: 'medios aéreos' },
  'layers.aircraft.title': {
    fr: 'Positions ADS-B reçues toutes les 4 s, animées avec 6 s de différé ; un historique court amorce les trajets et le suivi peut être incomplet',
    es: 'Posiciones ADS-B recibidas cada 4 s, animadas con 6 s de retardo; un historial corto inicia las trayectorias y el seguimiento puede ser incompleto',
  },
  'layers.aircraft.labels': {
    fr: 'matricules des appareils',
    es: 'matrículas de las aeronaves',
  },
  'layers.aircraft.labels.title': {
    fr: 'Afficher le matricule ou l’indicatif ADS-B à côté de chaque appareil',
    es: 'Mostrar la matrícula o el indicativo ADS-B junto a cada aeronave',
  },
  'layers.hint': {
    fr: 'Masquées : EFFIS ne publie que le contour le plus récent, pas son évolution. Ramenez le curseur à droite pour les revoir.',
    es: 'Ocultas: EFFIS solo publica el contorno más reciente, no su evolución. Lleva el cursor a la derecha para volver a verlas.',
  },

  /* ---------- météo ---------- */
  'weather.btn.aria': {
    fr: 'Prévisions météo au centre de la carte',
    es: 'Previsión meteorológica en el centro del mapa',
  },
  'weather.btn.title': {
    fr: 'Prévisions au centre de la carte — ou cliquez n’importe où sur la carte pour la météo de ce point',
    es: 'Previsión en el centro del mapa — o haz clic en cualquier punto del mapa para ver su meteorología',
  },
  'weather.btn.label': { fr: 'Météo', es: 'Tiempo' },
  'weather.title.center': {
    fr: 'Météo au centre de la carte',
    es: 'Tiempo en el centro del mapa',
  },
  'weather.title.pin': {
    fr: 'Météo au point choisi',
    es: 'Tiempo en el punto elegido',
  },
  'weather.follow': {
    fr: '↺ revenir au centre de la carte',
    es: '↺ volver al centro del mapa',
  },
  'weather.chart.aria': {
    fr: 'Évolution de la température, du vent et des précipitations',
    es: 'Evolución de la temperatura, el viento y las precipitaciones',
  },
  'weather.loading': {
    fr: 'Chargement des prévisions…',
    es: 'Cargando la previsión…',
  },
  'weather.unavailable': {
    fr: 'Prévisions momentanément indisponibles.',
    es: 'Previsión no disponible por el momento.',
  },
  'weather.nodata': {
    fr: 'Prévisions indisponibles à cette localisation.',
    es: 'No hay previsión disponible en esta ubicación.',
  },
  'weather.axis.temperature': { fr: 'Température', es: 'Temperatura' },
  'weather.axis.wind': {
    fr: 'Vent moyen et rafales',
    es: 'Viento medio y rachas',
  },
  'weather.axis.precipitation': {
    fr: 'Précipitations horaires',
    es: 'Precipitación horaria',
  },
  'weather.now': { fr: 'maintenant', es: 'ahora' },
  'weather.mapAt': { fr: 'carte {hour}', es: 'mapa {hour}' },
  'weather.kind.past': { fr: 'historique', es: 'histórico' },
  'weather.kind.forecast': { fr: 'prévision', es: 'previsión' },
  'weather.tip.wind': {
    fr: 'Vent de {dir}, {kmh} km/h',
    es: 'Viento del {dir}, {kmh} km/h',
  },
  'weather.tip.gust': { fr: 'Rafales : {kmh} km/h', es: 'Rachas: {kmh} km/h' },
  'weather.tip.precipitation': {
    fr: 'Précipitations : {mm} mm',
    es: 'Precipitación: {mm} mm',
  },
  'weather.chart.summary': {
    fr: 'Historique et prévisions météo sur 24 heures. Température de {first} à {last} degrés. Vent initial {speed} kilomètres heure, rafales {gust} kilomètres heure. Précipitations horaires maximales {precipitation} millimètres.',
    es: 'Histórico y previsión meteorológica de 24 horas. Temperatura de {first} a {last} grados. Viento inicial {speed} kilómetros por hora, rachas {gust} kilómetros por hora. Precipitación horaria máxima {precipitation} milímetros.',
  },
  'weather.badge.title': {
    fr: 'Température à 2 m au centre de la carte',
    es: 'Temperatura a 2 m en el centro del mapa',
  },
  'weather.badge.title.at': {
    fr: 'Température à 2 m au centre de la carte, au {date}',
    es: 'Temperatura a 2 m en el centro del mapa, a {date}',
  },
  'weather.geocode.error': {
    fr: 'Géocodage HTTP {status}',
    es: 'Geocodificación HTTP {status}',
  },

  /* ---------- export ---------- */
  'export.btn.aria': {
    fr: 'Partager ou exporter la carte',
    es: 'Compartir o exportar el mapa',
  },
  'export.btn.title': {
    fr: 'Partager ou exporter la carte en image ou GIF',
    es: 'Compartir o exportar el mapa como imagen o GIF',
  },
  'export.title': { fr: 'Exporter la carte', es: 'Exportar el mapa' },
  'export.kind.aria': {
    fr: 'Format d’export',
    es: 'Formato de exportación',
  },
  'export.kind.still': { fr: 'Image fixe', es: 'Imagen fija' },
  'export.kind.gif': { fr: 'GIF animé', es: 'GIF animado' },
  'export.wind': {
    fr: 'Afficher les lignes de vent',
    es: 'Mostrar las líneas de viento',
  },
  'export.gif.legend': { fr: 'Animation du GIF', es: 'Animación del GIF' },
  'export.gif.instant': {
    fr: 'À l’instant affiché',
    es: 'En el instante mostrado',
  },
  'export.gif.instant.hint': {
    fr: 'Le vent et les fumées s’animent quelques secondes.',
    es: 'El viento y el humo se animan durante unos segundos.',
  },
  'export.gif.evolution': { fr: 'Depuis le début', es: 'Desde el principio' },
  'export.gif.evolution.hint': {
    fr: 'Rejoue l’évolution de l’incendie comme le bouton Lecture.',
    es: 'Reproduce la evolución del incendio como el botón Reproducir.',
  },
  'export.generate.still': { fr: 'Générer l’image', es: 'Generar la imagen' },
  'export.generate.gif': { fr: 'Générer le GIF', es: 'Generar el GIF' },
  'export.preparing.still': {
    fr: 'Préparation de l’image 16:9…',
    es: 'Preparando la imagen 16:9…',
  },
  'export.preparing.gif': {
    fr: 'Préparation du GIF animé…',
    es: 'Preparando el GIF animado…',
  },
  'export.progress.gif': {
    fr: 'Création du GIF — {frame}/{total}',
    es: 'Creando el GIF — {frame}/{total}',
  },
  'export.shared.still': {
    fr: 'Image prête à partager.',
    es: 'Imagen lista para compartir.',
  },
  'export.shared.gif': {
    fr: 'GIF prêt à partager.',
    es: 'GIF listo para compartir.',
  },
  'export.saved.still': { fr: 'Image enregistrée.', es: 'Imagen guardada.' },
  'export.saved.gif': { fr: 'GIF enregistré.', es: 'GIF guardado.' },
  'export.cancelled': { fr: 'Partage annulé.', es: 'Se ha cancelado el envío.' },
  'export.failed': {
    fr: 'L’export a échoué. Réessayez dans un instant.',
    es: 'La exportación ha fallado. Inténtalo de nuevo en un momento.',
  },
  'export.encode.png': {
    fr: 'Le navigateur n’a pas pu encoder l’image.',
    es: 'El navegador no ha podido codificar la imagen.',
  },
  'export.encode.gif': {
    fr: 'Le navigateur n’a pas pu encoder le GIF.',
    es: 'El navegador no ha podido codificar el GIF.',
  },
  'export.share.title': {
    fr: 'Flamap.fr — carte des incendies',
    es: 'Flamap.fr — mapa de incendios',
  },
  'export.share.text': {
    fr: 'Carte des incendies en France — flamap.fr',
    es: 'Mapa de incendios en España — flamap.fr',
  },
  'export.footer.sources': {
    fr: 'Foyers : NASA FIRMS — Périmètres : Copernicus EFFIS — Vent : Météo-France / Open-Meteo',
    es: 'Focos: NASA FIRMS — Perímetros: Copernicus EFFIS — Viento: Météo-France / Open-Meteo',
  },
  'export.footer.base': {
    fr: 'Fond : IGN et Sentinel-2 / EOX — Toponymes : OpenStreetMap / OpenFreeMap',
    es: 'Base: IGN y Sentinel-2 / EOX — Topónimos: OpenStreetMap / OpenFreeMap',
  },
  'export.footer.shown': {
    fr: 'État affiché — {date}',
    es: 'Estado mostrado — {date}',
  },
  'export.footer.extracted': {
    fr: 'Données actualisées — {date}',
    es: 'Datos actualizados — {date}',
  },
  'export.footer.generated.still': {
    fr: 'Image générée — {date} ({zone})',
    es: 'Imagen generada — {date} ({zone})',
  },
  'export.footer.generated.gif': {
    fr: 'GIF généré — {date} ({zone})',
    es: 'GIF generado — {date} ({zone})',
  },
  'export.date.unavailable': { fr: 'indisponible', es: 'no disponible' },

  /* ---------- légende ---------- */
  'legend.title': { fr: 'Légende', es: 'Leyenda' },
  'legend.show': { fr: 'Afficher la légende', es: 'Mostrar la leyenda' },
  'legend.hide': { fr: 'Masquer la légende', es: 'Ocultar la leyenda' },
  'legend.collapse': { fr: 'Replier la légende', es: 'Plegar la leyenda' },
  'legend.expand': { fr: 'Déplier la légende', es: 'Desplegar la leyenda' },
  'legend.burnt.dated': { fr: 'touché', es: 'afectado' },
  'legend.burnt.dated.title': {
    fr: 'Périmètre touché par un incendie, recensé par EFFIS et daté au cran affiché. Donnée indicative susceptible d’être révisée',
    es: 'Perímetro afectado por un incendio, registrado por EFFIS y fechado en el paso mostrado. Dato orientativo, sujeto a revisión',
  },
  'legend.burnt.nrt': { fr: 'potentiel', es: 'potencial' },
  'legend.burnt.nrt.title': {
    fr: 'Périmètre potentiellement touché par un incendie, détecté automatiquement par EFFIS en quasi temps réel. Donnée indicative susceptible d’être révisée',
    es: 'Perímetro posiblemente afectado por un incendio, detectado automáticamente por EFFIS casi en tiempo real. Dato orientativo, sujeto a revisión',
  },
  'legend.age.title': {
    fr: 'Couleur d’un foyer selon son ancienneté, de dix jours à l’instant de la détection',
    es: 'Color de un foco según su antigüedad, de diez días al instante de la detección',
  },
  'legend.age.10d': { fr: '10 j', es: '10 d' },
  'legend.age.24h': { fr: '24 h', es: '24 h' },
  'legend.age.now': { fr: "à l'instant", es: 'ahora mismo' },
  'legend.psfdf.title': {
    fr: 'Statut courant des incendies suivis par l’association PSFDF, en France ; détection automatique par densité de foyers satellite hors de France',
    es: 'Estado actual de los incendios seguidos por la asociación PSFDF, en Francia; detección automática por densidad de focos de satélite fuera de Francia',
  },
  'legend.psfdf.heuristic.title': {
    fr: 'Amas de foyers FIRMS hors de France, sans suivi associatif',
    es: 'Agrupación de focos FIRMS fuera de Francia, sin seguimiento asociativo',
  },

  /* ---------- statuts PSFDF (valeurs de données traduites à l'affichage) ---------- */
  'status.Hors de contrôle': { fr: 'Hors de contrôle', es: 'Sin control' },
  'status.En cours': { fr: 'En cours', es: 'Activo' },
  'status.Fixé': { fr: 'Fixé', es: 'Estabilizado' },
  'status.Maîtrisé': { fr: 'Maîtrisé', es: 'Controlado' },
  'status.Éteint': { fr: 'Éteint', es: 'Extinguido' },
  'status.Détection auto': { fr: 'Détection auto', es: 'Detección auto' },
  'status.unknown': { fr: 'Statut inconnu', es: 'Estado desconocido' },
  'status.short.Hors de contrôle': { fr: 'hors contrôle', es: 'sin control' },
  'status.short.En cours': { fr: 'en cours', es: 'activo' },
  'status.short.Fixé': { fr: 'fixé', es: 'estabiliz.' },
  'status.short.Maîtrisé': { fr: 'maîtr.', es: 'controlado' },
  'status.short.Éteint': { fr: 'éteint', es: 'extinguido' },
  'status.short.Détection auto': { fr: 'détection auto', es: 'detección auto' },

  /* ---------- frise temporelle et mises à jour ---------- */
  'timeline.play': { fr: 'Lancer l’animation', es: 'Iniciar la animación' },
  'timeline.pause': { fr: 'Suspendre l’animation', es: 'Pausar la animación' },
  'timeline.slider.aria': {
    fr: 'Mise à jour affichée',
    es: 'Actualización mostrada',
  },
  'timeline.forecast': { fr: 'prévision', es: 'previsión' },
  'updates.aria': {
    fr: 'Dernières mises à jour des données',
    es: 'Últimas actualizaciones de los datos',
  },
  'updates.title': {
    fr: 'Mises à jour des données',
    es: 'Actualizaciones de los datos',
  },
  'updates.empty': {
    fr: 'Aucune mise à jour disponible.',
    es: 'No hay ninguna actualización disponible.',
  },
  'updates.sat': {
    fr: { one: '{count} foyer détecté', other: '{count} foyers détectés' },
    es: { one: '{count} foco detectado', other: '{count} focos detectados' },
  },
  'updates.effis': {
    fr: {
      one: '{count} périmètre récupéré{area}',
      other: '{count} périmètres récupérés{area}',
    },
    es: {
      one: '{count} perímetro recuperado{area}',
      other: '{count} perímetros recuperados{area}',
    },
  },
  'updates.effis.empty': {
    fr: 'Périmètres de zones brûlées actualisés',
    es: 'Perímetros de superficies quemadas actualizados',
  },
  'updates.wind': {
    fr: 'Prévision de vent actualisée',
    es: 'Previsión de viento actualizada',
  },

  /* ---------- graphique d'activité ---------- */
  'activity.open.aria': {
    fr: 'Ouvrir le graphique d’intensité des foyers détectés',
    es: 'Abrir el gráfico de intensidad de los focos detectados',
  },
  'activity.title': {
    fr: 'Intensité des détections',
    es: 'Intensidad de las detecciones',
  },
  'activity.tabs.aria': { fr: 'Métrique du graphique', es: 'Métrica del gráfico' },
  'activity.tab.frp': { fr: 'Puissance (MW)', es: 'Potencia (MW)' },
  'activity.tab.count': { fr: 'Nombre de foyers', es: 'Número de focos' },
  'activity.large.aria': {
    fr: 'Nombre de foyers détectés à chaque passage satellite',
    es: 'Número de focos detectados en cada paso del satélite',
  },
  'activity.title.frp': {
    fr: 'Puissance radiative détectée',
    es: 'Potencia radiativa detectada',
  },
  'activity.title.count': {
    fr: 'Nombre de foyers détectés',
    es: 'Número de focos detectados',
  },
  'activity.average': {
    fr: 'moyenne centrée sur {hours} h',
    es: 'media centrada en {hours} h',
  },
  'activity.scope.local': {
    fr: 'Passages dans la zone visible — échelle adaptée au pic local — ligne jaune : {average}.',
    es: 'Pasos en la zona visible — escala ajustada al pico local — línea amarilla: {average}.',
  },
  'activity.scope.national': {
    fr: 'Passages sur l’ensemble du domaine couvert — ligne jaune : {average}.',
    es: 'Pasos sobre todo el ámbito cubierto — línea amarilla: {average}.',
  },
  /* L'espagnol ne met pas d'espace avant les deux-points, le français si :
   * la ponctuation appartient au texte, pas au code qui l'assemble. */
  'activity.detail.meta': {
    fr: '{date} — {source} — {secondary} — {average} : {value}',
    es: '{date} — {source} — {secondary} — {average}: {value}',
  },
  'activity.empty': {
    fr: 'Aucun foyer détecté dans cette zone.',
    es: 'No se ha detectado ningún foco en esta zona.',
  },
  'activity.large.summary': {
    fr: '{count} passages satellite — {scope} — ligne de {average}',
    es: '{count} pasos de satélite — {scope} — línea de {average}',
  },
  'activity.open.metric': {
    fr: 'Ouvrir le graphique de {metric} {scope}',
    es: 'Abrir el gráfico de {metric} {scope}',
  },
  'activity.metric.frp': { fr: 'puissance radiative', es: 'potencia radiativa' },
  'activity.metric.count': { fr: 'nombre de foyers', es: 'número de focos' },
  'activity.scopeName.local': {
    fr: 'dans la zone visible',
    es: 'en la zona visible',
  },
  'activity.scopeName.national': {
    fr: 'sur l’ensemble du domaine couvert',
    es: 'sobre todo el ámbito cubierto',
  },
  'activity.frp.unavailable': {
    fr: 'La puissance sera disponible après la prochaine actualisation des données.',
    es: 'La potencia estará disponible tras la próxima actualización de los datos.',
  },
  'activity.count': {
    fr: { one: '{count} foyer', other: '{count} foyers' },
    es: { one: '{count} foco', other: '{count} focos' },
  },

  /* ---------- crédits ---------- */
  'credits.btn': { fr: 'crédits', es: 'créditos' },
  'credits.btn.wide': { fr: 'Sources & ', es: 'Fuentes y ' },
  'credits.fires': { fr: 'Foyers actifs', es: 'Focos activos' },
  'credits.burnt': { fr: 'Surfaces brûlées', es: 'Superficies quemadas' },
  'credits.psfdf': {
    fr: 'Incendies signalés et statuts',
    es: 'Incendios notificados y estados',
  },
  'credits.psfdf.name': {
    fr: 'Association Prévention et Signalement Feux de Forêt (PSFDF)',
    es: 'Asociación Prévention et Signalement Feux de Forêt (PSFDF)',
  },
  'credits.wind': { fr: 'Vent à 10 m', es: 'Viento a 10 m' },
  'credits.wind.models': { fr: 'modèles', es: 'modelos' },
  'credits.wind.note': {
    fr: 'sur la France et ARPEGE Europe sur la péninsule Ibérique, de Météo-France, servis par',
    es: 'sobre Francia y ARPEGE Europe sobre la península ibérica, de Météo-France, servidos por',
  },
  'credits.smoke': { fr: 'Fumée', es: 'Humo' },
  'credits.smoke.note': {
    fr: 'simulation indicative à partir de la puissance radiative FIRMS et du vent modélisé, et non mesure de qualité de l’air',
    es: 'simulación orientativa a partir de la potencia radiativa FIRMS y del viento modelizado; no es una medida de calidad del aire',
  },
  'credits.base': { fr: 'Fond', es: 'Base cartográfica' },
  'credits.base.ign': { fr: 'ortho-photo', es: 'ortofoto' },
  'credits.base.outside': { fr: 'hors France', es: 'fuera de Francia' },
  'credits.base.eox': {
    fr: 'par EOX (données Copernicus Sentinel modifiées 2020)',
    es: 'por EOX (datos Copernicus Sentinel modificados 2020)',
  },
  'credits.toponyms': { fr: 'Toponymes', es: 'Topónimos' },
  'credits.communes': { fr: 'Communes', es: 'Municipios' },
  'credits.aircraft': { fr: 'Moyens aériens', es: 'Medios aéreos' },
  'credits.aircraft.note': {
    fr: '(ADS-B communautaire, affichage non exhaustif)',
    es: '(ADS-B comunitario, visualización no exhaustiva)',
  },
  'credits.render': { fr: 'Rendu', es: 'Renderizado' },
  'credits.render.icons': { fr: 'icônes', es: 'iconos' },
  'credits.source': { fr: 'Code source', es: 'Código fuente' },
  'credits.archives': { fr: 'Feux archivés', es: 'Incendios archivados' },
  'credits.legal': {
    fr: 'Mentions légales & confidentialité',
    es: 'Aviso legal y privacidad',
  },
  /* La page légale existe en deux versions plutôt qu'en clés : c'est de la
   * prose juridique, elle doit rester relisible telle quelle. */
  'credits.legal.href': {
    fr: '/mentions-legales.html', es: '/aviso-legal.html',
  },
  'credits.updated': {
    fr: '— données extraites le {date} (heure de {zone}).',
    es: '— datos extraídos el {date} (hora de {zone}).',
  },

  /* ---------- fiches au clic ---------- */
  'popup.hotspot.title': { fr: 'Foyer détecté', es: 'Foco detectado' },
  'popup.hotspot.frp': { fr: 'MW rayonnés', es: 'MW radiados' },
  'popup.overview.title': {
    fr: { one: '{count} foyer en une heure', other: '{count} foyers en une heure' },
    es: { one: '{count} foco en una hora', other: '{count} focos en una hora' },
  },
  'popup.overview.frp': { fr: 'MW cumulés', es: 'MW acumulados' },
  'popup.overview.hint': {
    fr: 'Regroupement de la vue nationale — zoomez pour le détail.',
    es: 'Agrupación de la vista general — amplía para ver el detalle.',
  },
  'popup.burnt.title': { fr: 'Périmètre brûlé', es: 'Perímetro quemado' },
  'popup.burnt.sub': { fr: 'périmètre EFFIS', es: 'perímetro EFFIS' },
  'popup.burnt.start': {
    fr: 'Départ le {date} — {ago}',
    es: 'Inicio el {date} — {ago}',
  },
  'popup.burnt.natura': {
    fr: '{share} % en zone Natura 2000',
    es: '{share} % en zona Natura 2000',
  },
  'popup.nrt.title': {
    fr: 'Emprise en cours d’évaluation',
    es: 'Superficie en evaluación',
  },
  'popup.nrt.sub': { fr: 'EFFIS quasi temps réel', es: 'EFFIS casi en tiempo real' },
  'popup.nrt.note': {
    fr: 'Publiée sans date ni surface, elle peut englober d’anciennes cicatrices.',
    es: 'Publicada sin fecha ni superficie, puede abarcar cicatrices antiguas.',
  },
  'popup.weather.title': { fr: 'Météo à ce point', es: 'Tiempo en este punto' },
  'popup.weather.button': {
    fr: 'Prévisions météo',
    es: 'Previsión meteorológica',
  },
  'popup.weather.nowind': {
    fr: 'Modèle de vent non couvert à cet endroit.',
    es: 'Ningún modelo de viento cubre este lugar.',
  },
  'popup.weather.stamp': { fr: '{model}, au {date}', es: '{model}, a {date}' },

  /* ---------- occupation du sol EFFIS ---------- */
  'cover.CONIFER': { fr: 'conifères', es: 'coníferas' },
  'cover.BROADLEA': { fr: 'feuillus', es: 'frondosas' },
  'cover.MIXED': { fr: 'forêt mixte', es: 'bosque mixto' },
  'cover.SCLEROPH': { fr: 'maquis, garrigue', es: 'matorral esclerófilo' },
  'cover.TRANSIT': { fr: 'landes, recrû', es: 'matorral en transición' },
  'cover.OTHERNATLC': {
    fr: 'autres milieux naturels',
    es: 'otros medios naturales',
  },
  'cover.AGRIAREAS': { fr: 'surfaces agricoles', es: 'superficies agrícolas' },
  'cover.ARTIFSURF': { fr: 'surfaces bâties', es: 'superficies artificiales' },
  'cover.OTHERLC': { fr: 'autres', es: 'otros' },

  /* ---------- fiche PSFDF ---------- */
  'psfdf.now': { fr: 'à l’instant', es: 'ahora mismo' },
  'psfdf.ago.minutes': { fr: 'il y a {n} min', es: 'hace {n} min' },
  'psfdf.ago.hours': { fr: 'il y a {n} h', es: 'hace {n} h' },
  'psfdf.ago.days': { fr: 'il y a {n} j', es: 'hace {n} d' },
  'psfdf.incident': { fr: 'Incendie', es: 'Incendio' },
  'psfdf.incident.title': {
    fr: '{place}{detail} — zoomer sur cet incendie',
    es: '{place}{detail} — ampliar sobre este incendio',
  },
  'psfdf.incident.aria': {
    fr: 'Zoomer sur l’incendie de {place}, {metric}',
    es: 'Ampliar sobre el incendio de {place}, {metric}',
  },
  'psfdf.planes': {
    fr: { one: '{count} avion', other: '{count} avions' },
    es: { one: '{count} avión', other: '{count} aviones' },
  },
  'psfdf.helicopters': {
    fr: { one: '{count} hélico', other: '{count} hélicos' },
    es: { one: '{count} helicóptero', other: '{count} helicópteros' },
  },
  'psfdf.unknown.m': { fr: 'non renseigné', es: 'sin datos' },
  'psfdf.unknown.f': { fr: 'non renseignée', es: 'sin datos' },
  'psfdf.unknown.cap': { fr: 'Non renseigné', es: 'Sin datos' },
  'psfdf.place.heuristic': {
    fr: 'Zone détectée automatiquement',
    es: 'Zona detectada automáticamente',
  },
  'psfdf.place.reported': { fr: 'Incendie signalé', es: 'Incendio notificado' },
  'psfdf.updated.at': { fr: 'Mis à jour le {date}', es: 'Actualizado el {date}' },
  'psfdf.reported.at': { fr: 'Signalé le {date}', es: 'Notificado el {date}' },
  'psfdf.lastHotspot': {
    fr: 'Dernier foyer détecté du groupe',
    es: 'Último foco detectado del grupo',
  },
  'psfdf.sub.heuristic': {
    fr: 'Détection automatique par densité de foyers satellite',
    es: 'Detección automática por densidad de focos de satélite',
  },
  'psfdf.sub.tracked': { fr: 'Suivi actuel PSFDF', es: 'Seguimiento actual PSFDF' },
  'psfdf.sub.tracked.dept': {
    fr: '{departement}, suivi actuel PSFDF',
    es: '{departement}, seguimiento actual PSFDF',
  },
  'psfdf.stat.hotspots': {
    fr: 'Foyers FIRMS groupés',
    es: 'Focos FIRMS agrupados',
  },
  'psfdf.stat.radius': { fr: 'Rayon estimé', es: 'Radio estimado' },
  'psfdf.stat.area': { fr: 'Surface', es: 'Superficie' },
  'psfdf.stat.personnel': { fr: 'Personnel', es: 'Personal' },
  'psfdf.stat.aircraft': { fr: 'Moyens aériens', es: 'Medios aéreos' },
  'psfdf.stat.department': { fr: 'Département', es: 'Departamento' },
  'psfdf.note.heuristic': {
    fr: 'Détection automatique à partir des foyers actifs satellite (NASA FIRMS) : aucune association ne suit les incendies hors de France sur cette carte. À confirmer sur place.',
    es: 'Detección automática a partir de los focos activos por satélite (NASA FIRMS): ninguna asociación hace seguimiento de los incendios fuera de Francia en este mapa. Pendiente de confirmación sobre el terreno.',
  },
  'psfdf.more': { fr: 'Plus d’information', es: 'Más información' },
  'psfdf.more.source': { fr: 'Association PSFDF', es: 'Asociación PSFDF' },
  'psfdf.activity.title': {
    fr: 'Détections satellite',
    es: 'Detecciones por satélite',
  },
  'psfdf.activity.tabs.aria': {
    fr: 'Métrique du graphique local',
    es: 'Métrica del gráfico local',
  },
  'psfdf.activity.tab.count': { fr: 'Foyers', es: 'Focos' },
  'psfdf.activity.tab.frp': { fr: 'Puissance', es: 'Potencia' },
  'psfdf.activity.empty': {
    fr: 'Aucune détection récente à proximité.',
    es: 'Ninguna detección reciente en las inmediaciones.',
  },
  'psfdf.activity.caption': {
    fr: 'Zone estimée : rayon {radius} km ({basis}).',
    es: 'Zona estimada: radio {radius} km ({basis}).',
  },
  'psfdf.activity.caption.peak': {
    fr: 'Zone estimée : rayon {radius} km ({basis}) · pic : {peak}',
    es: 'Zona estimada: radio {radius} km ({basis}) · pico: {peak}',
  },
  'psfdf.activity.aria': {
    fr: '{count} passages satellite du {start} au {end}, maximum {peak}, dans une zone estimée de {radius} kilomètres de rayon',
    es: '{count} pasos de satélite del {start} al {end}, máximo {peak}, en una zona estimada de {radius} kilómetros de radio',
  },
  'psfdf.activity.max': { fr: 'Maximum : {peak}', es: 'Máximo: {peak}' },
  'psfdf.basis.surface': { fr: 'surface PSFDF', es: 'superficie PSFDF' },
  'psfdf.basis.effis': {
    fr: { one: 'périmètre EFFIS', other: '{count} périmètres EFFIS' },
    es: { one: 'perímetro EFFIS', other: '{count} perímetros EFFIS' },
  },
  'psfdf.basis.heuristic': {
    fr: '{count} foyers FIRMS groupés',
    es: '{count} focos FIRMS agrupados',
  },
  'psfdf.basis.hotspots': { fr: 'foyers FIRMS', es: 'focos FIRMS' },
  'psfdf.basis.minimum': { fr: 'marge minimale', es: 'margen mínimo' },
  'psfdf.name.heuristic': {
    fr: 'une zone d’activité détectée',
    es: 'una zona de actividad detectada',
  },
  'psfdf.name.reported': {
    fr: 'un incendie signalé',
    es: 'un incendio notificado',
  },

  /* ---------- moyens aériens ---------- */
  'aircraft.searching': {
    fr: 'Recherche des appareils en vol…',
    es: 'Buscando aeronaves en vuelo…',
  },
  'aircraft.flying': { fr: '{n} en vol', es: '{n} en vuelo' },
  'aircraft.flying.near': {
    fr: '{n} en vol, dont {near} près d’un incendie',
    es: '{n} en vuelo, {near} de ellas cerca de un incendio',
  },
  'aircraft.none': {
    fr: 'Aucun appareil suivi actuellement en vol.',
    es: 'Ninguna aeronave seguida está en vuelo ahora mismo.',
  },
  'aircraft.unavailable': {
    fr: 'Positions momentanément indisponibles.',
    es: 'Posiciones no disponibles por el momento.',
  },
  'aircraft.past': {
    fr: 'Masqués pendant la lecture du passé.',
    es: 'Ocultas durante la reproducción del pasado.',
  },
  'aircraft.nearFire': {
    fr: 'un incendie récent',
    es: 'un incendio reciente',
  },
  'aircraft.distance': {
    fr: 'à {km} km de {name}',
    es: 'a {km} km de {name}',
  },
  'aircraft.age.unknown': {
    fr: 'âge du signal inconnu',
    es: 'antigüedad de la señal desconocida',
  },
  'aircraft.age': {
    fr: 'signal ADS-B reçu il y a {n} s',
    es: 'señal ADS-B recibida hace {n} s',
  },
  'aircraft.delay': {
    fr: ' — affichage différé de {n} s — ICAO {icao}',
    es: ' — visualización retardada {n} s — ICAO {icao}',
  },
  'aircraft.history.http': {
    fr: 'historique aérien HTTP {status}',
    es: 'historial aéreo HTTP {status}',
  },
  'aircraft.history.invalid': {
    fr: 'historique aérien invalide',
    es: 'historial aéreo no válido',
  },

  /* ---------- vent ---------- */
  'wind.value': {
    fr: '{kmh} km/h (raf. {gust} km/h)',
    es: '{kmh} km/h (ráf. {gust} km/h)',
  },
  'wind.badge.title': {
    fr: 'Vent de {dir}, {kmh} km/h au centre de la carte, rafales à {gust} km/h',
    es: 'Viento del {dir}, {kmh} km/h en el centro del mapa, rachas de {gust} km/h',
  },
  /* Le français élide « de » devant une voyelle — « vent d’ouest », jamais
   * « de ouest » ; l’espagnol garde « del » dans tous les cas. */
  'wind.phrase': {
    fr: 'Vent de {dir}, {kmh} km/h (raf. {gust} km/h)',
    es: 'Viento del {dir}, {kmh} km/h (ráf. {gust} km/h)',
  },
  'wind.phrase.vowel': {
    fr: 'Vent d’{dir}, {kmh} km/h (raf. {gust} km/h)',
    es: 'Viento del {dir}, {kmh} km/h (ráf. {gust} km/h)',
  },
  'wind.model.unknown': { fr: 'modèle météo', es: 'modelo meteorológico' },
  'wind.card.0': { fr: 'nord', es: 'norte' },
  'wind.card.1': { fr: 'nord-nord-est', es: 'nor-noreste' },
  'wind.card.2': { fr: 'nord-est', es: 'noreste' },
  'wind.card.3': { fr: 'est-nord-est', es: 'este-noreste' },
  'wind.card.4': { fr: 'est', es: 'este' },
  'wind.card.5': { fr: 'est-sud-est', es: 'este-sureste' },
  'wind.card.6': { fr: 'sud-est', es: 'sureste' },
  'wind.card.7': { fr: 'sud-sud-est', es: 'sur-sureste' },
  'wind.card.8': { fr: 'sud', es: 'sur' },
  'wind.card.9': { fr: 'sud-sud-ouest', es: 'sur-suroeste' },
  'wind.card.10': { fr: 'sud-ouest', es: 'suroeste' },
  'wind.card.11': { fr: 'ouest-sud-ouest', es: 'oeste-suroeste' },
  'wind.card.12': { fr: 'ouest', es: 'oeste' },
  'wind.card.13': { fr: 'ouest-nord-ouest', es: 'oeste-noroeste' },
  'wind.card.14': { fr: 'nord-ouest', es: 'noroeste' },
  'wind.card.15': { fr: 'nord-nord-ouest', es: 'nor-noroeste' },

  /* ---------- formats ---------- */
  'format.clock': { fr: '{day} à {time}', es: '{day} a las {time}' },
  'format.time.separator': { fr: 'h', es: ':' },
  'format.now': { fr: "à l'instant", es: 'ahora mismo' },
  'format.ago.minutes': { fr: 'il y a {n} min', es: 'hace {n} min' },
  'format.ago.hours': { fr: 'il y a {n} h', es: 'hace {n} h' },
  'format.ago.days': {
    fr: { one: 'il y a {n} jour', other: 'il y a {n} jours' },
    es: { one: 'hace {n} día', other: 'hace {n} días' },
  },
  'format.confidence.low': { fr: 'confiance faible', es: 'confianza baja' },
  'format.confidence.nominal': {
    fr: 'confiance nominale',
    es: 'confianza nominal',
  },
  'format.confidence.high': { fr: 'confiance haute', es: 'confianza alta' },
  'format.confidence.percent': {
    fr: 'confiance {n} %',
    es: 'confianza {n} %',
  },
  'format.compass.north': { fr: 'N', es: 'N' },
  'format.compass.south': { fr: 'S', es: 'S' },
  'format.compass.east': { fr: 'E', es: 'E' },
  'format.compass.west': { fr: 'O', es: 'O' },

  /* ---------- page des feux archivés ---------- */
  'archive.title': { fr: 'Feux archivés | Flamap', es: 'Incendios archivados | Flamap' },
  'archive.description': {
    fr: 'Liste des incendies archivés par Flamap et rejeu de leur évolution : foyers satellite, surfaces brûlées et statut, feu par feu.',
    es: 'Lista de los incendios archivados por Flamap y reproducción de su evolución: focos de satélite, superficies quemadas y estado, incendio por incendio.',
  },
  'archive.back': { fr: 'Retour à Flamap', es: 'Volver a Flamap' },
  'archive.live': { fr: 'Voir la carte en direct', es: 'Ver el mapa en directo' },
  'archive.heading': { fr: 'Feux archivés', es: 'Incendios archivados' },
  'archive.intro': {
    fr: 'Tous les incendies signalés par PSFDF et suivis par Flamap, du plus récent au plus ancien. Cliquez sur un feu pour rejouer son évolution.',
    es: 'Todos los incendios notificados por PSFDF y seguidos por Flamap, del más reciente al más antiguo. Haz clic en un incendio para reproducir su evolución.',
  },
  'archive.list.back': { fr: '← Liste des feux', es: '← Lista de incendios' },
  'archive.slider.aria': { fr: 'Curseur temporel', es: 'Cursor temporal' },
  'archive.loading': { fr: 'Chargement des feux…', es: 'Cargando los incendios…' },
  'archive.list.error': {
    fr: 'Liste indisponible pour le moment — réessayez plus tard.',
    es: 'La lista no está disponible por el momento — inténtalo más tarde.',
  },
  'archive.list.errorLog': {
    fr: 'Liste des feux archivés indisponible',
    es: 'Lista de incendios archivados no disponible',
  },
  'archive.detail.loading': {
    fr: 'Chargement du feu…',
    es: 'Cargando el incendio…',
  },
  'archive.detail.error': {
    fr: 'Détail indisponible pour le moment — réessayez plus tard.',
    es: 'El detalle no está disponible por el momento — inténtalo más tarde.',
  },
  'archive.detail.errorLog': {
    fr: 'Détail du feu indisponible',
    es: 'Detalle del incendio no disponible',
  },
  'archive.notFound': {
    fr: 'Ce feu est introuvable — il a peut-être été renommé depuis.',
    es: 'No se encuentra este incendio — puede que se haya renombrado.',
  },
  'archive.empty': {
    fr: 'Aucun feu archivé pour le moment.',
    es: 'Ningún incendio archivado por el momento.',
  },
  'archive.burnt.start': { fr: 'Départ le {date}', es: 'Inicio el {date}' },
  'archive.commune.unknown': { fr: 'Commune inconnue', es: 'Municipio desconocido' },
  'archive.surface.max': {
    fr: 'ha (surface maximale connue)',
    es: 'ha (superficie máxima conocida)',
  },
  'archive.statuses': {
    fr: 'Statuts traversés : {list}',
    es: 'Estados atravesados: {list}',
  },
  'archive.tooShort': {
    fr: 'Pas assez de données conservées pour rejouer ce feu.',
    es: 'No se han conservado datos suficientes para reproducir este incendio.',
  },

  /* ---------- données indisponibles ---------- */
  'zones.detail.error': { fr: 'Détail indisponible', es: 'Detalle no disponible' },
};
