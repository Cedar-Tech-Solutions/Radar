import ChromeLink from "../../ChromeLink";
import LegalToc from "../LegalToc";
import TranslationNotice from "../TranslationNotice";
import { PRIVACY_LAST_UPDATED, legalDate } from "../legal-meta";

// French translation of page.tsx's article. The section ids are the same as the English ones so
// deep links (/fr/privacy#payments) land on the same section. Keep this in step with the English: a
// change to one document is a change to both, including the PROVIDERS, RETENTION and US_CATEGORIES
// rows. PROVIDERS here is objects, not three-string rows, so tests/site-claims.test.mjs's provider
// scan (which reads page.tsx) never has a second, French table to trip over.
export const PRIVACY_FR_META = {
  title: "Politique de confidentialité — Radar",
  description:
    "Les renseignements que Radar recueille, la façon dont ils sont utilisés, qui les traite, combien de temps ils sont conservés et les choix qui s’offrent à vous.",
};

const SECTIONS = [
  ["scope", "1. Portée de la présente politique"],
  ["collect", "2. Renseignements que nous recueillons"],
  ["use", "3. Utilisation des renseignements"],
  ["location", "4. Renseignements de localisation"],
  ["storage", "5. Témoins et stockage du navigateur"],
  ["payments", "6. Paiements"],
  ["email", "7. Notifications par courriel"],
  ["providers", "8. Fournisseurs de services"],
  ["sharing", "9. Quand nous communiquons des renseignements"],
  ["transfers", "10. Où les renseignements sont traités"],
  ["retention", "11. Durée de conservation des renseignements"],
  ["security", "12. Sécurité et responsabilité"],
  ["rights", "13. Vos droits et vos choix"],
  ["us-states", "14. Renseignements supplémentaires pour les résidents des États-Unis"],
  ["children", "15. Enfants"],
  ["changes", "16. Modifications de la présente politique"],
  ["contact", "17. Nous joindre et responsable de la protection des renseignements personnels"],
] as const;

const PROVIDERS = [
  {
    name: "Clerk",
    purpose: "Création de compte, connexion et gestion des sessions",
    data: "Adresse courriel, nom, identifiant de compte, événements d’authentification",
  },
  {
    name: "Cloudflare",
    purpose: "Hébergement de l’application, base de données, stockage d’images et protection anti-robots (Turnstile)",
    data: "Toutes les données conservées par le service ; adresse IP et métadonnées des requêtes en transit",
  },
  {
    name: "Stripe",
    purpose: "Paiement des abonnements Radar Pro et gestion de leur facturation",
    data: "Adresse courriel, données du mode de paiement que vous saisissez auprès de Stripe, état de l’abonnement",
  },
  {
    name: "Mapbox",
    purpose: "Conversion d’un code postal ou code ZIP, ou de l’adresse d’un restaurant, en un emplacement approximatif",
    data: "Le code postal ou code ZIP recherché ; des coordonnées approximatives",
  },
  {
    name: "OpenStreetMap (Nominatim)",
    purpose: "Recherche de relève des codes postaux et codes ZIP lorsque Mapbox n’est pas disponible",
    data: "Le code postal ou code ZIP recherché",
  },
  {
    name: "OpenStreetMap (carte intégrée)",
    purpose: "La carte d’une page d’offre, que votre navigateur charge à partir d’openstreetmap.org",
    data: "Votre adresse IP et les détails de votre navigateur, ainsi que l’adresse de la page d’offre que vous consultez",
  },
  {
    name: "Google",
    purpose:
      "Les icônes des sites Web des restaurants affichées dans les fiches, que votre navigateur charge à partir du service d’icônes de sites (favicons) de Google lorsque Radar n’a pas de logo enregistré ; la carte de l’application Android (Google Maps)",
    data: "Votre adresse IP et les détails de votre navigateur, l’adresse Web du restaurant et le fait que la requête provient de radar.cheap ; pour la carte, la zone qu’affiche votre appareil",
  },
  {
    name: "Apple",
    purpose: "Les achats intégrés et l’état des abonnements de l’application iOS, ainsi que la carte de l’application iOS (Plans d’Apple)",
    data: "Les identifiants de transaction et d’abonnement attribués par Apple ; l’état de l’abonnement ; pour la carte, la zone qu’affiche votre appareil",
  },
  {
    name: "Expo",
    purpose: "Livraison des notifications push à l’application Radar",
    data: "Le jeton push de votre installation et le contenu de la notification",
  },
  {
    name: "Resend",
    purpose: "Livraison des courriels d’alerte et de confirmation du projet pilote",
    data: "Adresse courriel ; événements de livraison, de rejet, de plainte et de désabonnement",
  },
  {
    name: "DeepL",
    purpose: "Traduction automatique des descriptions d’offres en français et en espagnol",
    data: "Le texte des fiches d’offres seulement — aucun renseignement personnel",
  },
] as const;

const RETENTION = [
  ["Compte et profil", "Tant que votre compte est ouvert. Supprimés lorsque vous supprimez le compte."],
  ["Favoris, zones suivies, restaurants masqués, paramètres d’alerte", "Jusqu’à ce que vous les supprimiez ou que vous supprimiez le compte."],
  ["Jetons push de l’application", "Jusqu’à ce que vous désactiviez les notifications, que vous vous déconnectiez ou que vous supprimiez le compte. Un jeton que la plateforme signale comme invalide est supprimé 30 jours plus tard."],
  ["Historique de consentement aux courriels et historique d’envois", "Tant que votre compte est ouvert, afin que vous puissiez voir ce qui a été envoyé et que nous puissions démontrer que vous y avez consenti. Supprimés avec le compte."],
  ["Liste d’exclusion (liste de suppression des courriels)", "Votre adresse courriel et le motif (désabonnement, rejet ou plainte) sont conservés après la suppression du compte, aussi longtemps que nous envoyons des courriels, afin que l’adresse ne reçoive plus jamais de courriel."],
  ["Listes d’attente et inscriptions aux nouvelles", "Jusqu’à ce que vous vous désabonniez ou que vous nous demandiez de retirer l’adresse. Une adresse qui se désabonne est transférée dans la liste d’exclusion. Une adresse jamais confirmée est supprimée 30 jours après le courriel de confirmation."],
  ["Rapports de livraison de notre fournisseur de courriel (envoyé, ouvert, rejeté)", "Supprimés automatiquement après 400 jours, ou avec le compte."],
  ["Signalements, commentaires, événements liés au produit et candidatures de créateurs liés à votre compte", "Supprimés avec le compte."],
  ["Suggestions d’offres", "La suggestion demeure dans l’historique de la fiche. Lorsque le compte est supprimé, son lien avec vous et l’adresse courriel de contact sont effacés."],
  ["Motifs d’annulation et réponses aux offres de rétention", "Conservés sous forme de statistiques anonymes. Leur lien avec vous est effacé lorsque le compte est supprimé."],
  ["Parrainage de créateur associé à votre compte", "Supprimé avec le compte. Une commission déjà gagnée conserve son montant et sa date, sans lien avec vous."],
  ["Dossiers de facturation", "Les identifiants d’abonnement sont supprimés avec le compte. Les factures et les dossiers de paiement sont conservés par Stripe et par nous pendant six ans après la fin de l’année d’imposition à laquelle ils se rapportent, comme l’exige la législation fiscale canadienne."],
  ["Dossiers de limitation de fréquence (un hachage à sens unique de votre adresse réseau)", "Supprimés automatiquement dans un délai d’un jour après la fin de la période de limitation."],
  ["Journaux des requêtes chez notre fournisseur d’hébergement", "Conservés par Cloudflare pendant au plus sept jours."],
  ["Dossiers d’audit du personnel", "Conservés pour montrer qui a modifié une fiche, un compte ou une autorisation, et quand. Ils identifient le membre du personnel et le dossier, et non vous par vos coordonnées."],
] as const;

const US_CATEGORIES = [
  { category: "Identifiants", examples: "Adresse courriel, nom d’affichage, identifiant de compte, jeton push, adresse IP (en transit)" },
  { category: "Renseignements commerciaux", examples: "Forfait Radar Pro, état de l’abonnement et identifiants de facturation" },
  { category: "Activité sur Internet ou sur un autre réseau électronique", examples: "Favoris, restaurants masqués, historique d’envoi des alertes, signalements et commentaires que vous envoyez" },
  { category: "Données de géolocalisation", examples: "Codes postaux ou codes ZIP que vous recherchez ou suivez. La position précise de l’appareil est utilisée pour une seule recherche et n’est pas conservée" },
  { category: "Renseignements personnels sensibles", examples: "Aucun n’est conservé. La position précise n’est utilisée que pour la recherche que vous avez demandée" },
] as const;

export default function PrivacyFr() {
  return (
    <article lang="fr">
      <span className="kicker">DERNIÈRE MISE À JOUR : {legalDate(PRIVACY_LAST_UPDATED, "fr")}</span>
      <h1>Politique de confidentialité</h1>
      <p className="lead">
        Radar aide les gens à trouver des offres de restaurants à proximité. La présente politique
        explique quels renseignements nous traitons, pourquoi, qui les traite pour notre compte,
        combien de temps nous les conservons et les choix qui s’offrent à vous. Nous ne vendons pas
        de renseignements personnels, nous ne les partageons pas à des fins de publicité
        comportementale intercontextuelle et nous ne les utilisons pour aucune forme de publicité
        de tiers.
      </p>

      <TranslationNotice />

      <LegalToc sections={SECTIONS} label="Table des matières" />

      <h2 id="scope">1. Portée de la présente politique</h2>
      <p>
        La présente politique couvre le site Web de Radar à radar.cheap, y compris le tableau de bord
        de l’utilisateur et le portail des restaurants, ainsi que les applications Radar pour iOS et
        Android. Les deux traitent les mêmes renseignements de la même façon, à deux exceptions près
        que décrivent les sections ci-dessous&nbsp;: l’application peut demander votre position au
        système d’exploitation, et elle peut s’inscrire aux notifications push. Cedar Tech Solutions
        est responsable des renseignements personnels décrits ici (le «&nbsp;responsable du
        traitement&nbsp;») et peut être jointe à{" "}
        <a href="mailto:support@cedartechsolutions.ca">support@cedartechsolutions.ca</a>. Votre
        utilisation de Radar est également régie par nos{" "}
        <ChromeLink href="/terms">Conditions d’utilisation</ChromeLink>.
      </p>
      <p>
        <strong>Responsable de la protection des renseignements personnels.</strong> La personne
        chargée de la protection des renseignements personnels chez Cedar Tech Solutions est notre
        responsable de la protection des renseignements personnels. On peut la joindre à{" "}
        <a href="mailto:support@cedartechsolutions.ca?subject=Attention%20%3A%20responsable%20de%20la%20protection%20des%20renseignements%20personnels">
          support@cedartechsolutions.ca
        </a>
        , en indiquant «&nbsp;Attention&nbsp;: responsable de la protection des renseignements
        personnels&nbsp;» dans l’objet. Voir{" "}
        <a href="#contact">Nous joindre et responsable de la protection des renseignements personnels</a>.
      </p>
      <p>
        La présente politique ne couvre pas les sites Web des restaurants ni les autres sites
        externes vers lesquels nous renvoyons. Ceux-ci ont leurs propres pratiques en matière de
        confidentialité.
      </p>

      <h2 id="collect">2. Renseignements que nous recueillons</h2>
      <p>
        <strong>Renseignements sur le compte.</strong> Lorsque vous vous connectez, notre fournisseur
        d’identité nous transmet votre identifiant de compte, votre adresse courriel et un nom
        d’affichage facultatif. Le profil de votre tableau de bord peut aussi contenir un nom
        d’affichage, une langue préférée, un pays, des unités de distance, un fuseau horaire, ainsi
        que le thème et la couleur d’accent que vous avez choisis.
      </p>
      <p>
        <strong>Ce que vous enregistrez et suivez.</strong> Les offres que vous ajoutez à vos
        favoris, les restaurants que vous avez masqués de vos résultats, les zones de code postal ou
        code ZIP que vous suivez avec leurs étiquettes et leurs rayons, votre code postal ou code ZIP
        de domicile et l’horaire de vos alertes.
      </p>
      <p>
        <strong>Contributions.</strong> Les suggestions d’offres peuvent comprendre le restaurant,
        l’offre, l’emplacement, l’horaire et une adresse courriel de contact que vous fournissez. Les
        signalements d’offres inexactes et les commentaires sur le produit peuvent comprendre la
        catégorie, votre message, le marché et la page où vous vous trouviez, l’offre concernée et
        les coordonnées du compte avec lequel vous êtes connecté. Les demandes des restaurants
        comprennent les renseignements sur l’entreprise et les coordonnées que vous saisissez.
      </p>
      <p>
        <strong>Listes d’attente et inscriptions aux nouvelles.</strong> Si vous laissez votre
        adresse courriel dans une case «&nbsp;tenez-moi au courant&nbsp;» ou de lancement de
        l’application sans avoir de compte, nous conservons l’adresse, le code postal si vous en avez
        fourni un, l’endroit où vous vous êtes inscrit et le moment où vous l’avez confirmée. Rien n’y
        est envoyé, à part un message de confirmation, tant que vous n’avez pas suivi le lien contenu
        dans ce message.
      </p>
      <p>
        <strong>Renseignements sur l’abonnement.</strong> Si vous vous abonnez à Radar Pro, nous
        conservons votre forfait, l’état de votre abonnement ainsi que les identifiants de client et
        d’abonnement attribués par notre processeur de paiement. Un abonnement acheté dans
        l’application iOS passe plutôt par Apple&nbsp;: nous conservons l’identifiant de transaction
        attribué par Apple, le produit, l’état et la date de renouvellement, et nous ne recevons
        jamais vos données de paiement. Voir <a href="#payments">Paiements</a>.
      </p>
      <p>
        <strong>Dossiers de communication.</strong> L’état de votre consentement aux courriels et ses
        horodatages, la version de la politique à laquelle vous avez consenti, ainsi qu’un historique
        d’envoi des messages que nous vous avons envoyés, y compris leur état et tout code d’erreur ou
        de rejet.
      </p>
      <p>
        <strong>Enregistrement de l’appareil.</strong> Si vous activez les notifications dans
        l’application Radar, nous conservons le jeton push que la plateforme attribue à cette
        installation et le fait qu’il s’agisse d’un appareil iOS ou Android, afin que les alertes
        puissent y être livrées. Le jeton identifie une installation plutôt qu’une personne, et il
        est supprimé lorsque vous désactivez les notifications, que vous vous déconnectez ou que la
        plateforme signale qu’il n’est plus valide.
      </p>
      <p>
        <strong>Renseignements techniques et d’utilisation.</strong> Les données de requête
        habituelles, comme l’adresse IP et l’agent utilisateur, sont traitées par notre fournisseur
        d’infrastructure afin de servir et de sécuriser le site, notamment pour la limitation de
        fréquence et les vérifications anti-robots. Nous consignons aussi des événements sommaires de
        visite liés aux campagnes — une source de référence, une campagne et un support tirés de la
        chaîne de requête d’un lien, le chemin de la page et le marché. Ces événements de visite ne
        sont pas liés à votre compte.
      </p>
      <p>
        <strong>Nombre de pages vues.</strong> Lorsqu’une page publique s’ouvre, votre navigateur
        indique à Radar qu’une page d’un certain type (la page d’accueil, une offre, un guide de
        ville ou une autre page) a été consultée, ainsi que le type de site d’où vous venez, comme un
        moteur de recherche ou un réseau social. Radar ajoute un à un compteur quotidien pour cette
        combinaison, avec le pays d’où provenait votre requête selon notre fournisseur
        d’infrastructure. Rien d’autre n’est conservé&nbsp;: aucun témoin (cookie) n’est déposé, et
        aucun compte, aucune adresse IP, aucun identifiant d’appareil ni aucune adresse de page n’est
        conservé avec le décompte, de sorte qu’il ne peut pas être relié à vous. Si votre navigateur
        envoie le signal Do Not Track ou Global Privacy Control, la page n’est pas comptée du tout.
      </p>
      <p>
        <strong>Parrainage par des créateurs.</strong> Certains créateurs partagent des liens vers
        Radar qui comportent leur pseudonyme (un <code>?c=</code> dans l’adresse). Lorsque vous
        arrivez par l’un d’eux, votre navigateur conserve ce pseudonyme, ainsi que l’étiquette de
        campagne si le lien en comporte une, dans deux témoins pendant 30 jours (voir{" "}
        <a href="#storage">Témoins et stockage du navigateur</a>). Si vous créez un compte Radar
        pendant qu’ils sont présents, nous enregistrons le pseudonyme et l’étiquette dans votre
        compte comme ceux du créateur qui vous a parrainé et, si vous payez ensuite Radar Pro sur le
        site Web, nous les copions dans le dossier de commission de ce paiement afin que le créateur
        puisse recevoir sa part. Le parrainage est inscrit une seule fois, à la création du compte,
        et un compte existant n’est jamais réattribué. Le créateur voit combien de personnes se sont
        inscrites et abonnées par ses liens et ce qu’il a gagné, mais jamais votre nom ni votre
        adresse courriel. Si votre navigateur envoie le signal Global Privacy Control, aucun
        parrainage n’est enregistré à partir d’un lien.
      </p>
      <p>
        <strong>Codes de parrainage.</strong> Vous pouvez aussi saisir vous-même le code de
        parrainage d’un créateur, sur la page d’inscription ou dans votre tableau de bord dans les 7
        jours suivant la création de votre compte. Comme c’est vous qui choisissez de le saisir, il
        est enregistré même si votre navigateur envoie le signal Global Privacy Control, et il est
        utilisé exactement comme un parrainage par lien. Un compte a un seul parrainage et, une fois
        inscrit, vous ne pouvez ni le modifier ni le retirer. Notre personnel peut corriger un
        parrainage ajouté par erreur si vous le demandez&nbsp;; chaque correction exige
        l’approbation d’un propriétaire et est conservée dans notre journal d’audit.
      </p>

      <h2 id="use">3. Utilisation des renseignements</h2>
      <ul>
        <li>Pour effectuer les recherches et afficher les résultats près de la zone que vous avez demandée.</li>
        <li>Pour conserver vos favoris, vos zones suivies, vos restaurants masqués et vos préférences d’affichage.</li>
        <li>Pour créer et administrer votre compte et maintenir votre connexion.</li>
        <li>Pour traiter les abonnements Radar Pro et appliquer à votre compte les limites du bon forfait.</li>
        <li>Pour envoyer les alertes et les confirmations que vous avez demandées, et en consigner la livraison.</li>
        <li>Pour examiner, modérer et publier les contributions de la communauté, avec un historique d’audit.</li>
        <li>
          Pour protéger le service — limitation de fréquence, vérifications anti-robots, prévention
          des abus et enquêtes de sécurité.
        </li>
        <li>Pour comprendre, de façon agrégée, quels marchés et quelles campagnes amènent des gens sur Radar.</li>
        <li>Pour créditer le créateur dont le lien vous a amené sur Radar, et pour lui verser sa commission.</li>
        <li>Pour respecter nos obligations légales et pour établir, exercer ou défendre des droits en justice.</li>
      </ul>
      <p>
        Nous n’utilisons les renseignements personnels qu’à ces fins, ou à une fin compatible avec
        celles-ci, à moins que vous ne consentiez à une autre fin ou que la loi ne l’exige. Lorsque la
        loi exige un fondement juridique, nous nous appuyons sur l’exécution de notre contrat avec
        vous (la gestion de votre compte et de votre abonnement), sur votre consentement (courriels de
        marketing et position précise de l’appareil), sur nos intérêts légitimes (la sécurisation et
        l’amélioration du service) et sur nos obligations légales (dossiers fiscaux et comptables).
        Radar ne prend pas de décisions à votre sujet fondées exclusivement sur un traitement
        automatisé&nbsp;: l’ordre des résultats de recherche dépend des offres et de votre recherche,
        et non d’un profil de vous.
      </p>

      <h2 id="location">4. Renseignements de localisation</h2>
      <p>
        <strong>Désactivée par défaut.</strong> Radar ne vous localise jamais de lui-même. La
        recherche fonctionne à partir du code postal ou code ZIP, ou de la ville, que vous tapez, et
        les fonctions de localisation restent désactivées jusqu’à ce que vous les activiez vous-même
        en choisissant «&nbsp;Utiliser ma position&nbsp;» et en accordant l’autorisation demandée par
        votre navigateur ou votre appareil.
      </p>
      <p>
        <strong>Sur le site Web.</strong> Lorsque vous choisissez «&nbsp;Utiliser ma position&nbsp;»,
        votre navigateur vous demande votre autorisation et fournit une position pour cette recherche
        seulement. Nous ne surveillons pas votre appareil en continu et nous ne conservons pas les
        coordonnées précises que votre navigateur a retournées. Vous pouvez retirer cette
        autorisation en tout temps dans les paramètres de site de votre navigateur.
      </p>
      <p>
        <strong>Dans l’application.</strong> L’application Radar demande l’autorisation au système
        d’exploitation la première fois que vous utilisez une recherche par position. La position est
        envoyée avec cette recherche, utilisée pour choisir et ordonner les résultats à proximité, et
        n’est pas consignée. La position n’est jamais demandée que lorsque l’application est ouverte,
        et Radar ne recueille pas votre position en arrière-plan. Vous pouvez la désactiver en tout
        temps dans les réglages de votre appareil. Refuser ne mène pas à une impasse&nbsp;: taper un
        code postal ou code ZIP donne les mêmes résultats.
      </p>
      <p>
        <strong>À partir de votre réseau.</strong> Comme pour tout site Web, le fournisseur
        d’hébergement de Radar voit l’adresse IP d’où provient votre requête et indique le pays, la
        province ou l’État et le fuseau horaire auxquels elle correspond. Radar n’utilise cette
        indication approximative que pendant qu’il répond à la requête&nbsp;: pour afficher les prix
        dans la bonne devise, pour déterminer de quel côté d’une frontière se trouve une recherche
        faite près de celle-ci, et pour connaître l’heure lorsque votre appareil ne l’a pas
        transmise. Elle n’est pas conservée avec votre compte.
      </p>
      <p>
        <strong>Ce qui est conservé.</strong> Les codes postaux ou codes ZIP que vous enregistrez
        comme zones suivies, ainsi que votre code postal ou code ZIP de domicile, sont conservés avec
        votre compte et peuvent être supprimés en tout temps à partir de votre tableau de bord.
      </p>

      <h2 id="storage">5. Témoins et stockage du navigateur</h2>
      <p>Radar n’utilise pas de témoins publicitaires. Voici ce que nous utilisons&nbsp;:</p>
      <ul>
        <li>
          <strong>Des témoins d’authentification</strong> déposés par notre fournisseur d’identité
          pour maintenir votre connexion. Ils sont nécessaires au fonctionnement des fonctions du
          compte.
        </li>
        <li>
          <strong>Un témoin de préférence linguistique</strong> afin que le site s’ouvre dans la
          langue que vous avez choisie en dernier.
        </li>
        <li>
          <strong>Des témoins de parrainage de créateurs</strong>, <code>radar_creator</code> et{" "}
          <code>radar_creator_campaign</code>, déposés seulement lorsque vous arrivez par le lien
          d’un créateur. Ils contiennent le pseudonyme du créateur et l’étiquette de campagne du lien
          pendant 30 jours, afin que le créateur puisse être crédité si vous créez un compte pendant
          cette période&nbsp;; à l’inscription, ils sont inscrits dans votre compte comme il est
          décrit à la section <a href="#collect">Renseignements que nous recueillons</a>. Tant
          qu’ils sont présents, la page d’accueil affiche les choix de ce créateur, et les offres que
          vous ouvrez sont comptées dans les totaux du créateur sans être liées à vous. Un lien de
          créateur ultérieur les remplace. Si votre navigateur envoie le signal Global Privacy
          Control, ils ne sont pas déposés, ceux qui l’étaient déjà sont supprimés, et un compte créé
          à partir de ce navigateur n’est attribué à aucun créateur par un lien.
        </li>
        <li>
          <strong>Le témoin de code de parrainage</strong>, <code>radar_referral_code</code>, déposé
          seulement lorsque vous saisissez un code de parrainage sur la page d’inscription. Il
          contient le pseudonyme du créateur pendant au plus 7 jours afin de l’inscrire dans votre
          compte à sa création, et il est supprimé si vous retirez le code. Les scripts de la page ne
          peuvent pas le lire.
        </li>
        <li>
          <strong>Le stockage local sur votre appareil</strong> pour votre thème et votre couleur
          d’accent, afin que la page s’affiche dans les bonnes couleurs avant la fin de son
          chargement, et pour quelques commodités&nbsp;: les offres que vous avez consultées
          récemment, le fait que vous ayez choisi ou non d’afficher les chaînes de restaurants, le
          dernier pays que vous avez parcouru, le nombre de visites avant que le site propose d’être
          installé et les avis que vous avez fermés. Le stockage de session conserve le chemin de
          retour vers vos résultats de recherche pendant que vous consultez une offre, ainsi que le
          fait que la page a été ouverte ou non depuis l’application iOS. Ces données restent dans
          votre navigateur et ne sont pas conservées par nous.
        </li>
        <li>
          <strong>Des jetons de protection anti-robots</strong> émis par Cloudflare Turnstile
          lorsque vous soumettez un formulaire, utilisés pour distinguer les personnes des abus
          automatisés.
        </li>
      </ul>
      <p>
        Vous pouvez effacer ces données dans les paramètres de votre navigateur&nbsp;; l’effacement
        des témoins d’authentification vous déconnecte.
      </p>

      <h2 id="payments">6. Paiements</h2>
      <p>
        Les paiements de Radar Pro sont traités par Stripe. Les numéros de carte et les autres
        données d’authentification de paiement sont saisis sur les propres pages de paiement et de
        facturation de Stripe et sont traités par Stripe — nous ne les recevons ni ne les conservons
        jamais. Ce que Radar conserve, c’est votre forfait, l’état de votre abonnement ainsi que les
        identifiants de client et d’abonnement Stripe nécessaires pour synchroniser les deux et pour
        ouvrir votre portail de facturation. Stripe traite ces renseignements à titre de responsable
        du traitement indépendant, selon sa propre politique de confidentialité, et peut les utiliser
        pour le traitement des paiements, la prévention de la fraude et ses propres obligations
        légales.
      </p>

      <h2 id="email">7. Notifications par courriel</h2>
      <p>
        Les alertes d’offres sont facultatives, et la création d’un compte ne vaut jamais
        consentement au marketing. L’envoi est limité à un projet pilote contrôlé et exige un
        consentement confirmé et consigné, une préférence activée, l’absence de suppression active et
        l’admissibilité au projet pilote. Nous consignons le moment où vous avez donné et retiré
        votre consentement, ainsi que la version de la politique en vigueur à ce moment, car c’est ce
        dossier qui démontre que le consentement était valide.
      </p>
      <p>
        Notre fournisseur de courriel traite les événements de livraison, de rejet, de plainte et de
        désabonnement afin que nous puissions cesser d’écrire aux adresses dont les courriels sont
        rejetés ou qui se plaignent. Chaque message de marketing comprend un moyen, en un clic, de
        cesser de recevoir les messages futurs, et vous pouvez désactiver les alertes en tout temps
        dans votre tableau de bord. Les messages transactionnels concernant votre compte sont envoyés
        quelles que soient vos préférences en matière de marketing.
      </p>

      <h2 id="providers">8. Fournisseurs de services</h2>
      <p>
        Nous ne communiquons des renseignements aux fournisseurs suivants que dans la mesure où ils
        en ont besoin pour remplir leur fonction pour nous, et chacun d’eux est tenu de les traiter à
        cette fin. Quelques-uns des services ci-dessous fonctionnent différemment&nbsp;: le service
        d’icônes de sites (favicons) de Google, la carte intégrée d’OpenStreetMap et les cartes des
        applications sont chargés par votre propre navigateur ou appareil lorsqu’une page affiche leur
        contenu&nbsp;; ils reçoivent donc votre adresse IP et les détails de votre navigateur comme
        tout site que vous visitez, et les traitent selon leur propre politique de confidentialité.
      </p>
      <div className="legal-table-wrap">
        <table className="legal-table">
          <thead>
            <tr>
              <th scope="col">Fournisseur</th>
              <th scope="col">Ce qu’il fait pour Radar</th>
              <th scope="col">Renseignements concernés</th>
            </tr>
          </thead>
          <tbody>
            {PROVIDERS.map(({ name, purpose, data }) => (
              <tr key={name}>
                <th scope="row">{name}</th>
                <td>{purpose}</td>
                <td>{data}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>
        Les photographies de restaurants affichées dans les fiches peuvent être récupérées à partir
        du propre site Web du restaurant. Le chargement d’une fiche n’envoie pas les renseignements
        de votre compte à ces sites.
      </p>

      <h2 id="sharing">9. Quand nous communiquons des renseignements</h2>
      <p>
        Outre les fournisseurs ci-dessus, nous ne communiquons de renseignements personnels que
        lorsque la loi ou une procédure judiciaire valide l’exige, lorsque c’est nécessaire pour
        enquêter sur une fraude, un abus ou un incident de sécurité ou pour les prévenir, pour
        établir ou défendre des droits en justice, ou dans le cadre d’une fusion, d’une acquisition
        ou d’une vente d’actifs — auquel cas nous vous en aviserons avant que vos renseignements ne
        deviennent assujettis à une politique de confidentialité différente.
      </p>
      <p>
        Les données des fiches de restaurants et les liens vers les sources sont des renseignements
        publics. Vos favoris, vos zones suivies, vos paramètres d’alerte et l’état de votre
        abonnement ne sont pas affichés publiquement. Les suggestions d’offres et les signalements
        que vous soumettez peuvent être publiés comme contenu des fiches, mais nous ne publions pas
        votre adresse courriel avec eux.
      </p>

      <h2 id="transfers">10. Où les renseignements sont traités</h2>
      <p>
        Radar est exploité à partir de l’Ontario, au Canada. Nos fournisseurs traitent des
        renseignements à l’extérieur du Canada et, pour les résidents du Québec, à l’extérieur du
        Québec&nbsp;: Clerk, Stripe, Mapbox, Resend, Expo, Apple et Google aux États-Unis&nbsp;;
        Cloudflare sur son réseau mondial, qui sert chaque requête à partir d’un centre de données
        près de chez vous&nbsp;; DeepL en Allemagne&nbsp;; et OpenStreetMap dans l’Union européenne
        et au Royaume-Uni. Les renseignements traités dans un autre pays sont assujettis aux lois de
        ce pays et peuvent être accessibles à ses tribunaux et à ses autorités.
      </p>
      <p>
        <strong>Avant que des renseignements quittent le Québec.</strong> Comme l’exige la loi
        québécoise, soit la Loi sur la protection des renseignements personnels dans le secteur privé
        (Loi 25), avant de communiquer à l’extérieur du Québec des renseignements personnels
        concernant un résident du Québec, nous évaluons s’ils bénéficieront d’une protection
        adéquate, en tenant compte de leur sensibilité, de la finalité de leur communication, des
        mesures de protection appliquées par le fournisseur (notamment le chiffrement en transit et
        au repos, et les contrôles d’accès) et du cadre juridique applicable dans l’endroit où ils
        sont communiqués. Chaque communication est encadrée par une entente écrite qui limite le
        fournisseur au service qu’il nous fournit. Nous n’envoyons à chaque fournisseur que ce dont
        il a besoin&nbsp;: pour la plupart, il s’agit d’une adresse courriel ou d’un identifiant, et
        nous ne leur transmettons jamais votre position précise.
      </p>

      <h2 id="retention">11. Durée de conservation des renseignements</h2>
      <p>
        Nous ne conservons les renseignements personnels que tant qu’ils sont nécessaires aux fins
        pour lesquelles ils ont été recueillis, ou aussi longtemps que la loi l’exige. Lorsque cette
        période prend fin, ils sont supprimés, ou anonymisés de façon à ne plus pouvoir vous
        identifier.
      </p>
      <div className="legal-table-wrap">
        <table className="legal-table">
          <thead>
            <tr>
              <th scope="col">Renseignements</th>
              <th scope="col">Durée de conservation</th>
            </tr>
          </thead>
          <tbody>
            {RETENTION.map(([category, period]) => (
              <tr key={category}>
                <th scope="row">{category}</th>
                <td>{period}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 id="security">12. Sécurité et responsabilité</h2>
      <p>
        Nous utilisons des contrôles d’accès, une administration fondée sur les rôles avec
        journalisation d’audit, le chiffrement des communications, la vérification de l’origine des
        requêtes, la limitation de fréquence et des vérifications anti-robots sur les formulaires
        publics. Le personnel n’a accès qu’aux renseignements dont son rôle a besoin. Les données
        d’authentification de paiement n’atteignent jamais nos systèmes. Aucun service Internet ne
        peut garantir une sécurité absolue, et vous êtes responsable de la sécurité de vos propres
        identifiants de connexion.
      </p>
      <p>
        <strong>Notre gouvernance des renseignements personnels.</strong> Notre responsable de la
        protection des renseignements personnels répond de la façon dont Radar protège les
        renseignements personnels, approuve toute nouvelle utilisation de ceux-ci et tout nouveau
        fournisseur, et répond aux demandes et aux plaintes. Avant d’adopter un nouveau système ou
        fournisseur qui traite des renseignements personnels, ou de les communiquer à l’extérieur du
        Québec, nous évaluons les risques pour la vie privée et la protection dont ils bénéficieront,
        et ne recueillons que ce dont la fonctionnalité a besoin. Les renseignements sont supprimés
        ou anonymisés à la fin des périodes indiquées à la section{" "}
        <a href="#retention">Durée de conservation des renseignements</a>, et certaines de ces
        suppressions s’effectuent automatiquement. Nous tenons un registre
        des incidents de confidentialité. Si un incident présente un risque de préjudice grave, nous
        en avisons les personnes concernées et les organismes de réglementation compétents (au
        Canada, le Commissariat à la protection de la vie privée du Canada et, pour les résidents du
        Québec, la Commission d’accès à l’information), comme l’exige la loi.
      </p>

      <h2 id="rights">13. Vos droits et vos choix</h2>
      <p>
        <strong>Dans le produit.</strong> Vous pouvez mettre à jour votre profil et vos préférences
        d’alerte, ajouter ou supprimer des zones suivies, retirer des favoris, modifier ou annuler
        votre abonnement, télécharger une copie des données de votre compte, supprimer votre compte
        et vous déconnecter — le tout à partir de votre tableau de bord.
      </p>
      <p>
        <strong>Sur demande.</strong> Selon l’endroit où vous habitez, vous pouvez avoir le droit
        d’accéder aux renseignements personnels que nous détenons à votre sujet, de les faire
        rectifier, de les faire supprimer, de les recevoir dans un format technologique structuré et
        couramment utilisé, de vous opposer à certains traitements ou d’en demander la limitation,
        et de retirer votre consentement en tout temps, sans incidence sur les traitements déjà
        effectués. Les résidents du Québec peuvent aussi nous demander de cesser de diffuser leurs
        renseignements personnels, ou de désindexer tout hyperlien rattaché à leur nom, lorsque
        cette diffusion contrevient à la loi ou à une ordonnance judiciaire ou leur cause un
        préjudice grave. Nous ne dégradons pas le service offert aux personnes qui exercent l’un ou
        l’autre de ces droits. Les résidents du Québec peuvent également demander de quelle façon un
        renseignement les concernant a été recueilli.
      </p>
      <p>
        Pour faire une demande, écrivez à notre responsable de la protection des renseignements
        personnels à{" "}
        <a href="mailto:support@cedartechsolutions.ca?subject=Demande%20relative%20%C3%A0%20la%20vie%20priv%C3%A9e">
          support@cedartechsolutions.ca
        </a>{" "}
        à partir de l’adresse associée à votre compte, en indiquant «&nbsp;demande relative à la vie
        privée&nbsp;» dans l’objet. Nous répondons dans un délai de 30 jours (45 jours pour les droits
        prévus par les lois des États américains décrits à la{" "}
        <a href="#us-states">section 14</a>), et nous pourrions devoir d’abord vérifier votre
        identité, habituellement en vous demandant de répondre à partir de l’adresse associée à votre
        compte. Certains dossiers survivent à un compte sous la forme réduite décrite à la section{" "}
        <a href="#retention">Durée de conservation des renseignements</a>.
      </p>
      <p>
        Si vous n’êtes pas satisfait de notre réponse, vous pouvez porter plainte auprès de
        l’autorité de protection de la vie privée dont vous relevez&nbsp;: au Canada, le Commissariat
        à la protection de la vie privée du Canada&nbsp;; au Québec, la Commission d’accès à
        l’information&nbsp;; aux États-Unis, le procureur général de votre État (ou, en Californie,
        la California Privacy Protection Agency, l’agence californienne de protection de la vie
        privée)&nbsp;; dans l’Espace économique européen ou au Royaume-Uni, votre autorité de
        contrôle nationale.
      </p>

      <h2 id="us-states">14. Renseignements supplémentaires pour les résidents des États-Unis</h2>
      <p>
        La présente section s’applique aux résidents de la Californie et des autres États américains
        dotés de lois complètes sur la protection de la vie privée. Elle s’ajoute au reste de la
        présente politique.
      </p>
      <p>
        <strong>Ce que nous recueillons et pourquoi.</strong> Au cours des 12 derniers mois, Radar a
        recueilli les catégories ci-dessous, auprès de vous, de votre appareil et des fournisseurs
        d’identité et de paiement que vous utilisez pour vous connecter et payer, aux fins décrites à
        la section <a href="#use">Utilisation des renseignements</a>. Nous ne communiquons chacune
        d’elles à des fins opérationnelles qu’aux fournisseurs de services énumérés à la section{" "}
        <a href="#providers">Fournisseurs de services</a>, et conservons chacune d’elles pendant les
        durées indiquées à la section{" "}
        <a href="#retention">Durée de conservation des renseignements</a>.
      </p>
      <div className="legal-table-wrap">
        <table className="legal-table">
          <thead>
            <tr>
              <th scope="col">Catégorie</th>
              <th scope="col">Ce que cela signifie chez Radar</th>
            </tr>
          </thead>
          <tbody>
            {US_CATEGORIES.map(({ category, examples }) => (
              <tr key={category}>
                <th scope="row">{category}</th>
                <td>{examples}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>
        <strong>Aucune vente, aucun partage, aucune publicité ciblée.</strong> Radar ne vend pas de
        renseignements personnels, ne les partage pas à des fins de publicité comportementale
        intercontextuelle, ne les traite pas à des fins de publicité ciblée et ne les utilise pas pour
        du profilage produisant des effets juridiques ou des effets d’importance similaire. Il n’a
        fait aucune de ces choses au cours des 12 derniers mois, et il ne vend ni ne partage
        sciemment les renseignements de personnes de moins de 16 ans.
      </p>
      <p>
        <strong>Do Not Track.</strong> Radar ne vous suit pas sur d’autres sites et ne permet pas à
        des tiers de vous suivre sur Radar. Si votre navigateur envoie le signal Do Not Track, Radar
        ne compte pas vos pages vues.
      </p>
      <p>
        <strong>Global Privacy Control.</strong> Nous traitons un signal Global Privacy Control
        envoyé par votre navigateur comme une demande de refus&nbsp;: un navigateur qui l’envoie
        n’est pas compté dans les pages vues et ne reçoit pas de témoins de parrainage de créateurs,
        de sorte qu’aucun parrainage n’est rattaché à un compte créé à partir de celui-ci. Vous
        n’avez pas besoin d’un compte pour que cela fonctionne.
      </p>
      <p>
        <strong>Vos droits.</strong> Selon votre État, vous pouvez demander à connaître les
        renseignements personnels que nous détenons à votre sujet et à y accéder (y compris les
        catégories et les éléments précis), à les faire rectifier, à les faire supprimer et à en
        recevoir une copie portable, ainsi qu’à refuser la vente, le partage, la publicité ciblée et
        le profilage (ce que Radar ne fait pas). Nous ne ferons pas preuve de discrimination à votre
        égard parce que vous exercez ces droits. Faites une demande de la façon décrite à la
        section <a href="#rights">Vos droits et vos choix</a>.
      </p>
      <p>
        <strong>Mandataires autorisés.</strong> Une personne que vous autorisez peut faire une
        demande en votre nom. Nous vous demanderons votre autorisation signée et pourrions vous
        demander de confirmer votre identité directement auprès de nous, à moins que le mandataire
        ne détienne une procuration valide.
      </p>
      <p>
        <strong>Appels.</strong> Si nous refusons votre demande, vous pouvez faire appel en répondant
        à notre décision avec «&nbsp;appel&nbsp;» dans l’objet. Nous répondrons à l’appel par écrit
        dans un délai de 60 jours, en expliquant ce que nous avons décidé et pourquoi. Si vous êtes en
        désaccord avec le résultat, vous pouvez communiquer avec le procureur général de votre État.
      </p>

      <h2 id="children">15. Enfants</h2>
      <p>
        Radar ne s’adresse pas aux enfants. Vous devez avoir au moins 14&nbsp;ans pour créer un
        compte, et nous ne recueillons pas sciemment de renseignements personnels auprès de personnes
        plus jeunes. Si nous apprenons qu’un compte appartient à une personne de moins de
        14&nbsp;ans, nous le supprimons. Si vous croyez qu’un enfant nous a fourni des
        renseignements, écrivez à{" "}
        <a href="mailto:support@cedartechsolutions.ca">support@cedartechsolutions.ca</a> et nous les
        supprimerons.
      </p>

      <h2 id="changes">16. Modifications de la présente politique</h2>
      <p>
        Nous pouvons mettre à jour la présente politique à mesure que le service évolue ou que la loi
        l’exige. La date de «&nbsp;dernière mise à jour&nbsp;» indiquée en haut de la page identifie
        la version en vigueur. Pour les modifications importantes, nous prendrons des mesures
        raisonnables pour vous en aviser avant leur entrée en vigueur et, lorsque la modification
        exige votre consentement, nous vous le demanderons.
      </p>

      <h2 id="contact">17. Nous joindre et responsable de la protection des renseignements personnels</h2>
      <p>
        Les questions relatives à la vie privée, les demandes concernant les données, les plaintes et
        tout le reste doivent être adressées à{" "}
        <a href="mailto:support@cedartechsolutions.ca">support@cedartechsolutions.ca</a>. Pour
        joindre le responsable de la protection des renseignements personnels, indiquez
        «&nbsp;Attention&nbsp;: responsable de la protection des renseignements personnels&nbsp;»
        dans l’objet. Une personne lit chaque message.
      </p>
    </article>
  );
}
