// server/services/grilleRc2018.js
// RC Automobile - circulaire n°05266/MRF/DGTCP du 23 mai 2018 (zone unique).
// Durées de la grille : 12, 6, 3, 1 mois (deux-roues : 12 et 6).
// Taux des garanties facultatives (vol, incendie, tous risques) à faire valider par SONAM.

const DUREES_VOITURE = [12, 6, 3, 1];
const DUREES_MOTO = [12, 6];
const BONUS = [0, 0.10, 0.19, 0.25, 0.30, 0.35];
const DR = [7950, 4214, 2226, 795];
const IPT = [12000, 6360, 3360, 1200];
const ACC = [5000, 3000, 1500, 750];
const CED = [1000, 1000, 1000, 1000];
const RATIO = [1, 0.53, 0.28, 0.10];

const RC_VOITURE = [
  [73415, 38910, 20557, 7342],
  [114693, 60788, 32114, 11468],
  [129058, 68401, 36136, 12906],
];
const RC_MOTO = [[11642, 6170], [19058, 10101], [27891, 14782], [35858, 19005], [47814, 25341]];

const FORMULES = ['tiers', 'tiersEtendu', 'tousRisques'];

function palier({ type, carburant, cv, cylindreeIdx }) {
  if (type === 'moto') return Math.min(Math.max(cylindreeIdx | 0, 0), 4);
  if (carburant === 'essence') return cv <= 9 ? 0 : cv <= 11 ? 1 : 2;
  return cv <= 6 ? 0 : cv <= 8 ? 1 : 2;
}
const tauxVol = (v, cv) => cv > 9
  ? (v <= 10e6 ? 0.003 : v <= 15e6 ? 0.004 : 0.006)
  : (v <= 10e6 ? 0.003 : v <= 15e6 ? 0.0035 : v <= 20e6 ? 0.0045 : 0.005);
const tauxTR = (v) => (v <= 5e6 ? 0.03 : v <= 15e6 ? 0.035 : 0.045);

function dureeValide(type, mois) {
  return (type === 'moto' ? DUREES_MOTO : DUREES_VOITURE).includes(mois);
}

function calculer({ type = 'voiture', carburant = 'essence', cv = 7, cylindreeIdx = 0,
                    anneesSansSinistre = 0, formule = 'tiers', valeurVehicule = 8000000, dureeMois }) {
  if (!dureeValide(type, dureeMois)) throw new Error(`Durée ${dureeMois} mois hors grille`);
  const moto = type === 'moto';
  const p = (moto ? DUREES_MOTO : DUREES_VOITURE).indexOf(dureeMois);
  const rc = (moto ? RC_MOTO : RC_VOITURE)[palier({ type, carburant, cv, cylindreeIdx })][p];

  const dr = moto ? (p === 1 ? 530 : 1000) : DR[p];
  const ipt = moto ? 0 : IPT[p];
  const acc = moto ? 500 : ACC[p];
  const ced = moto ? 0 : CED[p];

  const remise = Math.round(rc * BONUS[Math.min(Math.max(anneesSansSinistre | 0, 0), 5)]);
  const pn = rc + dr + ipt;
  const taxes = Math.round((pn - remise + acc) * 0.145);
  const fga = Math.round((rc - remise) * 0.02);

  let opt = 0;
  if (!moto && formule !== 'tiers') {
    const base = formule === 'tiersEtendu'
      ? valeurVehicule * (tauxVol(valeurVehicule, cv) + 0.0035)
      : valeurVehicule * tauxTR(valeurVehicule);
    opt = Math.round(base * RATIO[p] * 1.145);
  }

  const lignes = [
    ['Responsabilité civile', rc], ['Défense et recours', dr],
    ...(moto ? [] : [['Individuelle personnes transportées', ipt]]),
    ['Frais d’accessoires', acc],
    ...(remise > 0 ? [['Bonus fidélité', -remise]] : []),
    ...(opt > 0 ? [[formule === 'tiersEtendu' ? 'Vol et incendie' : 'Dommages tous risques', opt]] : []),
    ['Taxes', taxes], ['Fonds de garantie (FGA)', fga],
    ...(moto ? [] : [['Attestation CEDEAO', ced]]),
  ].map(([libelle, montant]) => ({ libelle, montant }));

  return { lignes, total: lignes.reduce((s, l) => s + l.montant, 0), dureeMois };
}

module.exports = { calculer, dureeValide, FORMULES, DUREES_VOITURE, DUREES_MOTO };
