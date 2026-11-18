// Ferdige quizpakker (fase 10.4). Statisk klientdata: valget fyller QuizEditor
// og blir `plan.quiz` ved opprettelse. Reglene er de samme som chase._quiz_norm()
// (lib/rules/quiz.ts); test/quizPacks.test.ts kjører alle pakker gjennom dem.
// Innholdet bør leses over av en lærer. Unngå tall og fakta som endrer seg ofte.

import type { QuizItem } from "@/lib/rules/quiz";

export interface QuizPack {
  id: string;
  title: string;
  /** Anbefalt trinn, fra og med / til og med. */
  grades: [number, number];
  subject: string;
  /** Kort kobling til kompetansemål i LK20 (egne ord, ikke sitat). */
  lk20: string;
  items: QuizItem[];
}

const Q = (q: string, a: string[], c: number): QuizItem => ({ q, a, c });

export const QUIZ_PACKS: QuizPack[] = [
  {
    id: "gangetabellen",
    title: "Gangetabellen",
    grades: [5, 7],
    subject: "Matematikk",
    lk20: "Multiplikasjon og divisjon med hele tall i hodet (tall og algebra, 5.–7. trinn).",
    items: [
      Q("6 × 7 = ?", ["36", "42", "48"], 1),
      Q("8 × 9 = ?", ["63", "72", "81"], 1),
      Q("7 × 8 = ?", ["54", "56", "64"], 1),
      Q("9 × 9 = ?", ["72", "81", "90"], 1),
      Q("12 × 4 = ?", ["44", "48", "52"], 1),
      Q("6 × 8 = ?", ["42", "48", "54"], 1),
      Q("11 × 11 = ?", ["111", "121", "131"], 1),
      Q("7 × 9 = ?", ["56", "63", "72"], 1),
      Q("56 ÷ 7 = ?", ["7", "8", "9"], 1),
      Q("72 ÷ 8 = ?", ["8", "9", "7"], 1),
      Q("5 × 12 = ?", ["50", "60", "70"], 1),
    ],
  },
  {
    id: "brok-prosent",
    title: "Brøk og prosent",
    grades: [6, 8],
    subject: "Matematikk",
    lk20: "Regne med brøk, desimaltall og prosent og veksle mellom dem (tall og algebra).",
    items: [
      Q("Hvor mange prosent er 1/2?", ["25 %", "50 %", "75 %"], 1),
      Q("Hva er 25 % av 80?", ["20", "25", "40"], 0),
      Q("Hva er 3/4 som desimaltall?", ["0,34", "0,6", "0,75"], 2),
      Q("Hva er 10 % av 350?", ["3,5", "35", "350"], 1),
      Q("Hva er 1/4 + 1/4?", ["1/8", "2/8", "1/2"], 2),
      Q("Hva er 50 % av 36?", ["12", "18", "20"], 1),
      Q("Hvilken brøk er størst?", ["1/2", "2/3", "3/4"], 2),
      Q("Hva er 0,2 som brøk?", ["1/2", "1/5", "1/20"], 1),
      Q("Hva er 20 % av 150?", ["15", "30", "75"], 1),
      Q("En vare koster 200 kr og får 25 % rabatt. Hva blir den nye prisen?", ["175 kr", "150 kr", "125 kr"], 1),
      Q("Hvor mange prosent er 2/5?", ["20 %", "25 %", "40 %"], 2),
    ],
  },
  {
    id: "norges-geografi",
    title: "Norges geografi",
    grades: [5, 7],
    subject: "Samfunnsfag",
    lk20: "Utforske og beskrive natur og landskap i Norge og bruke kart (geografi, 5.–7. trinn).",
    items: [
      Q("Hva heter Norges høyeste fjell?", ["Glittertind", "Galdhøpiggen", "Snøhetta"], 1),
      Q("Hva heter Norges lengste elv?", ["Tana", "Numedalslågen", "Glomma"], 2),
      Q("Hva heter Norges største innsjø?", ["Mjøsa", "Femunden", "Tyrifjorden"], 0),
      Q("Hvilken by er kjent som «regnbyen»?", ["Bergen", "Stavanger", "Bodø"], 0),
      Q("Hvilket av disse landene grenser ikke til Norge?", ["Sverige", "Finland", "Danmark"], 2),
      Q("Hva heter Norges lengste fjord?", ["Hardangerfjorden", "Sognefjorden", "Oslofjorden"], 1),
      Q("Hvilken by er den nest største i Norge?", ["Trondheim", "Bergen", "Stavanger"], 1),
      Q("Hva heter fjellkjeden langs store deler av grensen mot Sverige?", ["Alpene", "Ural", "Kjølen"], 2),
      Q("Hvilken av disse byene ligger lengst nord?", ["Bodø", "Trondheim", "Tromsø"], 2),
      Q("Hva kalles det når sola ikke går ned om sommeren i Nord-Norge?", ["Nordlys", "Midnattssol", "Polarnatt"], 1),
    ],
  },
  {
    id: "europas-hovedsteder",
    title: "Europas hovedsteder",
    grades: [6, 9],
    subject: "Samfunnsfag",
    lk20: "Kjenne til land og hovedsteder i Europa og orientere seg på kart (geografi).",
    items: [
      Q("Hva er hovedstaden i Spania?", ["Barcelona", "Madrid", "Sevilla"], 1),
      Q("Hva er hovedstaden i Italia?", ["Milano", "Napoli", "Roma"], 2),
      Q("Hva er hovedstaden i Portugal?", ["Lisboa", "Porto", "Madrid"], 0),
      Q("Hva er hovedstaden i Hellas?", ["Aten", "Roma", "Istanbul"], 0),
      Q("Hva er hovedstaden i Polen?", ["Krakow", "Warszawa", "Praha"], 1),
      Q("Hva er hovedstaden i Østerrike?", ["Wien", "Salzburg", "Bern"], 0),
      Q("Hva er hovedstaden i Finland?", ["Tallinn", "Helsinki", "Riga"], 1),
      Q("Hva er hovedstaden i Irland?", ["Belfast", "Cork", "Dublin"], 2),
      Q("Hva er hovedstaden i Nederland?", ["Rotterdam", "Amsterdam", "Brussel"], 1),
      Q("Hva er hovedstaden i Sveits?", ["Zürich", "Genève", "Bern"], 2),
      Q("Hva er hovedstaden i Ungarn?", ["Budapest", "Wien", "Bucuresti"], 0),
    ],
  },
  {
    id: "kroppen-helse",
    title: "Naturfag: kroppen og helse",
    grades: [5, 7],
    subject: "Naturfag / kroppsøving",
    lk20: "Kroppen, puls og pust, og hvorfor fysisk aktivitet og kosthold er viktig for helsen.",
    items: [
      Q("Hvilket organ pumper blodet rundt i kroppen?", ["Lungene", "Hjertet", "Magen"], 1),
      Q("Hvor mange tenner har en voksen normalt, med visdomstenner?", ["28", "32", "36"], 1),
      Q("Hva er hovedoppgaven til de røde blodcellene?", ["Frakte oksygen", "Bekjempe sykdom", "Fordøye mat"], 0),
      Q("Hva skjer vanligvis med pulsen når du løper?", ["Den går ned", "Den blir lik", "Den går opp"], 2),
      Q("Hvilken gass tar kroppen opp fra lufta når vi puster inn?", ["Oksygen", "Karbondioksid", "Helium"], 0),
      Q("Hva heter den lengste knokkelen i kroppen?", ["Overarmsbeinet", "Lårbeinet", "Leggbeinet"], 1),
      Q("Hvor mye fysisk aktivitet anbefales barn og unge hver dag?", ["10 minutter", "30 minutter", "Minst 60 minutter"], 2),
      Q("Hvilket vitamin lager kroppen selv med hjelp av sollys?", ["Vitamin C", "Vitamin D", "Vitamin K"], 1),
      Q("Hvilket næringsstoff gir mest energi per gram?", ["Fett", "Karbohydrater", "Protein"], 0),
      Q("Hva er best å drikke for å fylle på væske etter en økt?", ["Brus", "Saft", "Vann"], 2),
    ],
  },
  {
    id: "okologi-dyr",
    title: "Naturfag: økologi og dyr i norsk natur",
    grades: [5, 8],
    subject: "Naturfag",
    lk20: "Næringskjeder, samspill i naturen og tilpasning hos dyr og planter (økologi).",
    items: [
      Q("Hva kalles dyr som bare spiser planter?", ["Planteetere", "Rovdyr", "Altetere"], 0),
      Q("Hvilket av disse er et rovdyr?", ["Elg", "Hare", "Gaupe"], 2),
      Q("Hva kalles det når dyr sover gjennom vinteren?", ["Trekk", "Dvale", "Hamskifte"], 1),
      Q("Hvilken av disse fuglene trekker sørover om høsten?", ["Spurv", "Svale", "Skjære"], 1),
      Q("Hva kalles organismer som sopp og bakterier, som bryter ned døde planter og dyr?", ["Produsenter", "Rovdyr", "Nedbrytere"], 2),
      Q("Hva trenger planter for fotosyntesen?", ["Sollys, vann og karbondioksid", "Bare vann og jord", "Oksygen og sand"], 0),
      Q("Hva kalles stedet der en dyreart naturlig lever?", ["Habitat", "Hybrid", "Hamskifte"], 0),
      Q("Hvilket dyr feller og får nytt gevir hvert år?", ["Geit", "Villsvin", "Elg"], 2),
      Q("Hva kalles dyr som spiser både planter og kjøtt?", ["Planteetere", "Altetere", "Nedbrytere"], 1),
      Q("Hva er en produsent i et økosystem?", ["Dyr som jakter", "Grønne planter som lager sin egen næring", "Sopp som bryter ned døde dyr"], 1),
    ],
  },
  {
    id: "engelsk-ordforrad",
    title: "Engelsk: ordforråd",
    grades: [5, 7],
    subject: "Engelsk",
    lk20: "Forstå og bruke vanlige ord og uttrykk i engelsk (språklæring).",
    items: [
      Q("Hva betyr «butterfly»?", ["Smørbrød", "Sommerfugl", "Flue"], 1),
      Q("Hva er «Wednesday» på norsk?", ["Tirsdag", "Onsdag", "Torsdag"], 1),
      Q("Hva betyr «knee»?", ["Kne", "Albue", "Ankel"], 0),
      Q("Hva betyr «because»?", ["Fordi", "Mens", "Hvis"], 0),
      Q("Hva heter «ost» på engelsk?", ["Bread", "Cheese", "Butter"], 1),
      Q("Hva heter «gul» på engelsk?", ["Green", "Yellow", "Brown"], 1),
      Q("Hva betyr «beautiful»?", ["Vakker", "Sterk", "Fort"], 0),
      Q("Hva er flertall av «child»?", ["Childs", "Childen", "Children"], 2),
      Q("Hva betyr «always»?", ["Aldri", "Alltid", "Av og til"], 1),
      Q("Hva betyr «tired»?", ["Sulten", "Trøtt", "Redd"], 1),
    ],
  },
  {
    id: "norsk-ordklasser",
    title: "Norsk: ordklasser",
    grades: [6, 8],
    subject: "Norsk",
    lk20: "Kjenne igjen ordklasser og bruke fagbegreper om språket (språk og tekst).",
    items: [
      Q("Hvilken ordklasse er «hund»?", ["Substantiv", "Verb", "Adjektiv"], 0),
      Q("Hvilken ordklasse er «løpe»?", ["Substantiv", "Verb", "Adverb"], 1),
      Q("Hvilken ordklasse er «rask»?", ["Verb", "Pronomen", "Adjektiv"], 2),
      Q("Hvilken ordklasse er «han»?", ["Pronomen", "Preposisjon", "Verb"], 0),
      Q("Hvilken ordklasse er «og»?", ["Adjektiv", "Konjunksjon", "Substantiv"], 1),
      Q("Hvilken ordklasse er «på»?", ["Preposisjon", "Adverb", "Verb"], 0),
      Q("Hvilket ord er verb i «Katten sover på sofaen»?", ["Katten", "sover", "sofaen"], 1),
      Q("Hvilket ord er adjektiv i «Den store hunden bjeffet»?", ["store", "hunden", "bjeffet"], 0),
      Q("Hvilket ord er substantiv i «Jenta leser raskt»?", ["leser", "raskt", "Jenta"], 2),
      Q("Hvilken ordklasse er «alltid»?", ["Adverb", "Adjektiv", "Substantiv"], 0),
    ],
  },
  {
    id: "demokrati-stortinget",
    title: "Samfunnsfag: demokrati og Stortinget",
    grades: [8, 10],
    subject: "Samfunnsfag",
    lk20: "Demokrati, valg, rettigheter og hvordan makt er fordelt i Norge (samfunnskunnskap).",
    items: [
      Q("Hvor mange representanter har Stortinget?", ["150", "169", "200"], 1),
      Q("Hvor ofte er det stortingsvalg i Norge?", ["Hvert tredje år", "Hvert fjerde år", "Hvert sjette år"], 1),
      Q("Hvilket år fikk Norge sin grunnlov?", ["1814", "1905", "1945"], 0),
      Q("Hva betyr ordet demokrati?", ["Kongestyre", "Folkestyre", "Militærstyre"], 1),
      Q("Hvilken av disse er ikke en av de tre statsmaktene?", ["Den lovgivende makt", "Den dømmende makt", "Den religiøse makt"], 2),
      Q("Hvem vedtar lovene i Norge?", ["Stortinget", "Høyesterett", "Statsforvalteren"], 0),
      Q("Fra hvilken alder kan du stemme ved stortingsvalg?", ["16 år", "18 år", "21 år"], 1),
      Q("I hvilket år fikk kvinner allmenn stemmerett i Norge?", ["1814", "1913", "1945"], 1),
      Q("Hva betyr ytringsfrihet?", ["Rett til å si og skrive meningene sine", "Rett til å slippe skole", "Rett til å ta andres eiendeler"], 0),
      Q("Hva kalles det når flere partier styrer sammen?", ["Opposisjon", "Valgkrets", "Koalisjon"], 2),
    ],
  },
  {
    id: "friluftsliv",
    title: "Friluftsliv og allemannsretten",
    grades: [5, 10],
    subject: "Kroppsøving",
    lk20: "Ferdes trygt i naturen, kjenne allemannsretten og vise hensyn og respekt (friluftsliv).",
    items: [
      Q("Hva kalles retten til å ferdes fritt i naturen?", ["Allemannsretten", "Jaktretten", "Eiendomsretten"], 0),
      Q("Hvor langt fra bebodd hus skal du minst telte i utmark?", ["50 meter", "150 meter", "500 meter"], 1),
      Q("Når er det forbudt å gjøre opp bål i skog og mark?", ["1. juni til 1. august", "15. april til 15. september", "1. november til 1. mars"], 1),
      Q("Hvor lenge kan du normalt telte på samme sted i utmark?", ["Inntil to døgn", "Inntil to uker", "Så lenge du vil"], 0),
      Q("Når er det båndtvang for hund i utmark?", ["1. april til 20. august", "1. september til 31. oktober", "Hele året unntatt jul"], 0),
      Q("Hva gjør du med søppelet ditt på tur?", ["Gjemmer det under en stein", "Tar det med hjem", "Brenner plasten på bålet"], 1),
      Q("Hva er et godt prinsipp for klær på tur?", ["Én tykk bomullsgenser", "Bare en vindjakke", "Flere tynne lag"], 2),
      Q("Hvor mange fjellvettregler finnes det?", ["5", "9", "12"], 1),
      Q("Hvilket nødnummer ringer du for ambulanse?", ["110", "112", "113"], 2),
      Q("Hvilken retning peker en kompassnål mot?", ["Nord", "Sør", "Vest"], 0),
    ],
  },
];

export const QUIZ_PACK_SUBJECTS = [...new Set(QUIZ_PACKS.map((p) => p.subject))];

/** Pakker som passer for trinnet (null = alle) og faget (null = alle). */
export function filterQuizPacks(grade: number | null, subject: string | null): QuizPack[] {
  return QUIZ_PACKS.filter(
    (p) => (grade === null || (grade >= p.grades[0] && grade <= p.grades[1])) && (subject === null || p.subject === subject),
  );
}
