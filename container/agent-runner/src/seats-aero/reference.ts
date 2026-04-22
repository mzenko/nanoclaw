// Reference material exposed as MCP resources. Splitting these out of
// server.ts keeps the registration code tidy. Each export is a string
// the agent reads on demand via the seats-aero://* URIs.

export const MULTI_CITY_CODES = `# seats.aero multi-city codes — full mappings

Source: https://docs.seats.aero/article/73-searching-multiple-airports-or-cities-at-once

These 3-letter codes (and one 5-letter, INDIA) can be passed in originAirport
or destinationAirport instead of an IATA code. The API expands them server-side.

⚠️ Codes are CURATED ("Large Airports") lists, NOT exhaustive. Combining region
codes broadens coverage. Even combinations miss smaller airports (AUS, BNA, MCO,
RDU, RSW, SAV, etc. aren't in any code). Airline-hub codes (UAH/AAH/DLL) ARE
exhaustive for that carrier.

## Metro areas
- NYC → JFK, LGA, EWR
- LON → LGW, LHR, LCY, STN, LTN
- WAS → IAD, DCA, BWI
- CHI → ORD, MDW
- PAR → CDG, ORY
- TYO → HND, NRT
- OSA → KIX, ITM
- SEL → ICN, GMP
- BJS → PEK, PKX
- SAO → GRU, CGH, VCP
- RIO → GIG, SDU
- YTO → YYZ, YTZ

## US regions
- EST (East Coast) → JFK, LGA, EWR, BOS, PHL, PIT, IAD, DCA, CLT
- WST (West Coast — note: includes mountain-time hubs) → LAX, SFO, SJC, SEA, SAN, PDX, DEN, YVR, LAS, SLC, PHX
- CAL (California) → LAX, SFO, SJC, SAN, OAK, SMF
- MIW (Midwest) → ORD, MDW, DTW, CLE, CVG, IND, MSP
- QBA (Bay Area) → SFO, SJC, OAK
- QLA (LA metro) → LAX, BUR, SNA, ONT, LGB
- QMI (Miami metro) → MIA, FLL, PBI
- HAW (Hawaii) → HNL, OGG, KOA, LIH

## Continents and large regions
- USA → SFO, LAX, JFK, EWR, ORD, ATL, IAD, IAH, DEN, MIA, SEA, DFW, BOS (13 hubs only)
- EUR → AMS, ATH, BCN, BER, CDG, DUB, FRA, IST, LHR, MUC, MAD, FCO, MXP, ZRH, HEL, ARN, WAW, BRU, LGW, CPH, LIS, VIE, GVA, EDI
- SCH (Schengen) → AMS, ATH, BCN, BER, CDG, FRA, MUC, MAD, FCO, MXP, ZRH, HEL, ARN, WAW, BRU, CPH, LIS, VIE, GVA, PMI, TFS, NCE, DBV, AGP
- ASA (Asia large) → HND, NRT, SIN, BKK, ICN, HKG, KUL, TPE, PVG, PEK, PKX
- SAS (Southeast Asia) → SIN, KUL, BKK, SGN, HAN, MNL, CGK, DPS
- MEA (Middle East) → DXB, AUH, DOH
- CAR (Caribbean) → CUR, AUA, BON, AXA, ANU, STT, STX, BGI, HAV, PUJ, SDQ, MBJ, SJU, SXM
- CAM (Central America) → BZE, GUA, FRS, SAL, SAP, RTB, TGU, LCE, MGA, SJO, LIR, PTY, DAV, BLB
- SAM (South America) → EZE, AEP, COR, MDZ, SCL, IPC, LIM, CUZ, BOG, MDE, CTG, UIO, GYE, GIG, GRU, BSB, SSA, REC, FOR, POA, FLN, ASU, MVD, CCS, VVI, LPB, SRE, GEO, PBM, CAY
- LAM (Latin America = SAM + CAM + Mexico/Caribbean) → EZE, AEP, COR, MDZ, SCL, IPC, LIM, CUZ, BOG, MDE, CTG, UIO, GYE, GIG, GRU, BSB, SSA, REC, FOR, POA, FLN, ASU, MVD, CCS, VVI, LPB, SRE, GEO, PBM, CAY, BZE, GUA, FRS, SAL, SAP, RTB, TGU, LCE, MGA, SJO, LIR, PTY, DAV, BLB, MEX, CUN, GDL, MTY, SJD, PVR, HAV, SNU, VRA, HOG, SCU, PUJ, SDQ, STI, POP, AZS, SJU, PSE, BQN, PAP, CAP, JAK, CYA, PTP, FDF, SBH, SFG
- QAF (Africa) → CAI, CMN, ADD, JNB, CPT, NBO, JRO, HLE, ZNZ
- ANZ (Australia + NZ) → SYD, MEL, BNE, PER, AKL, ADL
- AUL (Australia only) → SYD, MEL, BNE, PER, ADL

## Country
- CAD (Canada) → YYZ, YUL, YVR, YYC, YEG, YOW, YHZ, YWG, YQB, YQR, YXE
- MXC (Mexico) → MEX, CUN, GDL, MTY, SJD, PVR
- GER (Germany) → MUC, FRA, BER
- UKD (UK) → LHR, LGW, EDI, MAN
- JPN (Japan) → HND, NRT, KIX, ITM
- INDIA → BOM, DEL, HYD, BLR, MAA, COK, CCU, AMD, TRV
- CNA (mainland China) → PEK, PKX, PVG, CAN, SZX, CKG, TFU
- BRL (Brazil — large set) → GRU, GIG, CNF, BSB, CGH, SSA, REC, POA, FLN, CWB, FOR, MAO, BEL, VCP, SDU, NAT, SLZ, MCZ, AJU, JPA, IGU, THE, GYN, CPV, PVH, RBR, JDO, UDI, SJP, CGR, IOS, PMW, CXJ, STM, MAB

## Airline hubs (exhaustive for that carrier)
- UAH (United hubs) → DEN, LAX, SFO, ORD, IAD, EWR, IAH
- AAH (American hubs) → MIA, DFW, PHX, CLT, PHL, JFK, ORD
- DLL (Delta hubs) → ATL, DTW, MSP, SLC, SEA, LAX, JFK, BOS
`;

export const SOURCES_REFERENCE = `# seats.aero mileage program sources (canonical)

Source: https://developers.seats.aero/reference/concepts-copy

Pass any of these as the \`source\` (single) or \`sources\` (csv) parameter.
The list is NOT exhaustive — the API returns sources beyond it (e.g. "british"
for British Airways Executive Club). Pass any user-mentioned program; the API
returns 400 on unknown values.

| Source | Program | Cabins (Y=econ, W=prem, J=biz, F=first) | Seat counts | Trip data |
|---|---|---|---|---|
| eurobonus | SAS EuroBonus | Y/J | Yes | Yes |
| virginatlantic | Virgin Atlantic Flying Club | Y/W/J | Yes | Yes |
| aeromexico | Aeromexico Club Premier | Y/W/J | Yes | Yes |
| american | American Airlines | Y/W/J/F | No (mostly) | Yes |
| delta | Delta SkyMiles | Y/W/J | Yes | Yes |
| etihad | Etihad Guest | Y/J/F | Yes | Yes |
| united | United MileagePlus | Y/W/J/F | Yes | Yes |
| emirates | Emirates Skywards | Y/W/J/F | No | Yes (some fields missing on connections) |
| aeroplan | Air Canada Aeroplan | Y/W/J/F | Yes (rarely 0) | Yes |
| alaska | Alaska Mileage Plan | Y/W/J/F | Yes | Yes |
| velocity | Virgin Australia Velocity | Y/W/J/F | Yes | Yes |
| qantas | Qantas Frequent Flyer | Y/W/J/F | No | Yes |
| connectmiles | Copa ConnectMiles | Y/J/F | No | Yes |
| azul | Azul TudoAzul | Y/J | No | Yes |
| smiles | GOL Smiles | Y/W/J/F | Yes | Yes |
| flyingblue | Air France/KLM Flying Blue | Y/W/J/F | Yes | Yes |
| jetblue | JetBlue TrueBlue | Y/W/J/F | Yes | Yes |
| qatar | Qatar Privilege Club | Y/J/F | No | Yes (no taxes returned) |
| turkish | Turkish Miles & Smiles | Y/J | No | Yes (no taxes returned) |
| singapore | Singapore KrisFlyer | Y/W/J/F | No | Yes (no taxes returned) |
| ethiopian | Ethiopian ShebaMiles | Y/J | Yes | Yes |
| saudia | Saudi AlFursan | Y/J/F | Yes | Yes |
| finnair | Finnair Plus | Y/W/J/F | Yes | Yes |
| lufthansa | Lufthansa Miles & More | Y/J/F | Yes | Yes |
| frontier | Frontier Airlines | Y | No | Yes |
| spirit | Spirit Airlines | Y | Yes | Yes |

Known additional source not in canonical table: british (British Airways Executive Club).
`;
