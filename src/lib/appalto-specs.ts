export interface AppaltoSiteSpec {
  name: string;
  displayName: string;
  operations: {
    name: string;
    description: string;
    args?: string[];
  }[];
}

export const APPALTO_SPECS: AppaltoSiteSpec[] = [
  {
    name: "ted-appalti",
    displayName: "TED — Bandi UE sopra soglia",
    operations: [
      { name: "search_notices", description: "Ricerca bandi TED per CIG/CUP o parola chiave", args: ["query", "id"] },
      { name: "notice_detail", description: "Dettaglio avviso TED completo", args: ["id"] },
    ],
  },
  {
    name: "anac-bdncp",
    displayName: "ANAC/BDNCP — CIG nazionali",
    operations: [
      { name: "search_cig", description: "Cerca un CIG nel dataset ANAC", args: ["cig"] },
      { name: "get_cig_detail", description: "Dettaglio CIG: importo, aggiudicatario, CPV", args: ["cig"] },
      { name: "search_by_region", description: "Gare aperte per regione", args: ["region"] },
    ],
  },
];
