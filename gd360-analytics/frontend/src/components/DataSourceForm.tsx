import { FormEvent, useState } from "react";
import { api } from "../api/client";

// Real brand marks (path data + official color from the Simple Icons
// project, MIT licensed - simpleicons.org), shown purely so a database
// type is instantly recognizable by its logo instead of a plain text
// dropdown, the same way any connector picker does.
function PostgresLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path d="M23.5594 14.7228a.5269.5269 0 0 0-.0563-.1191c-.139-.2632-.4768-.3418-1.0074-.2321-1.6533.3411-2.2935.1312-2.5256-.0191 1.342-2.0482 2.445-4.522 3.0411-6.8297.2714-1.0507.7982-3.5237.1222-4.7316a1.5641 1.5641 0 0 0-.1509-.235C21.6931.9086 19.8007.0248 17.5099.0005c-1.4947-.0158-2.7705.3461-3.1161.4794a9.449 9.449 0 0 0-.5159-.0816 8.044 8.044 0 0 0-1.3114-.1278c-1.1822-.0184-2.2038.2642-3.0498.8406-.8573-.3211-4.7888-1.645-7.2219.0788C.9359 2.1526.3086 3.8733.4302 6.3043c.0409.818.5069 3.334 1.2423 5.7436.4598 1.5065.9387 2.7019 1.4334 3.582.553.9942 1.1259 1.5933 1.7143 1.7895.4474.1491 1.1327.1441 1.8581-.7279.8012-.9635 1.5903-1.8258 1.9446-2.2069.4351.2355.9064.3625 1.39.3772a.0569.0569 0 0 0 .0004.0041 11.0312 11.0312 0 0 0-.2472.3054c-.3389.4302-.4094.5197-1.5002.7443-.3102.064-1.1344.2339-1.1464.8115-.0025.1224.0329.2309.0919.3268.2269.4231.9216.6097 1.015.6331 1.3345.3335 2.5044.092 3.3714-.6787-.017 2.231.0775 4.4174.3454 5.0874.2212.5529.7618 1.9045 2.4692 1.9043.2505 0 .5263-.0291.8296-.0941 1.7819-.3821 2.5557-1.1696 2.855-2.9059.1503-.8707.4016-2.8753.5388-4.1012.0169-.0703.0357-.1207.057-.1362.0007-.0005.0697-.0471.4272.0307a.3673.3673 0 0 0 .0443.0068l.2539.0223.0149.001c.8468.0384 1.9114-.1426 2.5312-.4308.6438-.2988 1.8057-1.0323 1.5951-1.6698zM2.371 11.8765c-.7435-2.4358-1.1779-4.8851-1.2123-5.5719-.1086-2.1714.4171-3.6829 1.5623-4.4927 1.8367-1.2986 4.8398-.5408 6.108-.13-.0032.0032-.0066.0061-.0098.0094-2.0238 2.044-1.9758 5.536-1.9708 5.7495-.0002.0823.0066.1989.0162.3593.0348.5873.0996 1.6804-.0735 2.9184-.1609 1.1504.1937 2.2764.9728 3.0892.0806.0841.1648.1631.2518.2374-.3468.3714-1.1004 1.1926-1.9025 2.1576-.5677.6825-.9597.5517-1.0886.5087-.3919-.1307-.813-.5871-1.2381-1.3223-.4796-.839-.9635-2.0317-1.4155-3.5126zm6.0072 5.0871c-.1711-.0428-.3271-.1132-.4322-.1772.0889-.0394.2374-.0902.4833-.1409 1.2833-.2641 1.4815-.4506 1.9143-1.0002.0992-.126.2116-.2687.3673-.4426a.3549.3549 0 0 0 .0737-.1298c.1708-.1513.2724-.1099.4369-.0417.156.0646.3078.26.3695.4752.0291.1016.0619.2945-.0452.4444-.9043 1.2658-2.2216 1.2494-3.1676 1.0128zm2.094-3.988-.0525.141c-.133.3566-.2567.6881-.3334 1.003-.6674-.0021-1.3168-.2872-1.8105-.8024-.6279-.6551-.9131-1.5664-.7825-2.5004.1828-1.3079.1153-2.4468.079-3.0586-.005-.0857-.0095-.1607-.0122-.2199.2957-.2621 1.6659-.9962 2.6429-.7724.4459.1022.7176.4057.8305.928.5846 2.7038.0774 3.8307-.3302 4.7363-.084.1866-.1633.3629-.2311.5454zm7.3637 4.5725c-.0169.1768-.0358.376-.0618.5959l-.146.4383a.3547.3547 0 0 0-.0182.1077c-.0059.4747-.054.6489-.115.8693-.0634.2292-.1353.4891-.1794 1.0575-.11 1.4143-.8782 2.2267-2.4172 2.5565-1.5155.3251-1.7843-.4968-2.0212-1.2217a6.5824 6.5824 0 0 0-.0769-.2266c-.2154-.5858-.1911-1.4119-.1574-2.5551.0165-.5612-.0249-1.9013-.3302-2.6462.0044-.2932.0106-.5909.019-.8918a.3529.3529 0 0 0-.0153-.1126 1.4927 1.4927 0 0 0-.0439-.208c-.1226-.4283-.4213-.7866-.7797-.9351-.1424-.059-.4038-.1672-.7178-.0869.067-.276.1831-.5875.309-.9249l.0529-.142c.0595-.16.134-.3257.213-.5012.4265-.9476 1.0106-2.2453.3766-5.1772-.2374-1.0981-1.0304-1.6343-2.2324-1.5098-.7207.0746-1.3799.3654-1.7088.5321a5.6716 5.6716 0 0 0-.1958.1041c.0918-1.1064.4386-3.1741 1.7357-4.4823a4.0306 4.0306 0 0 1 .3033-.276.3532.3532 0 0 0 .1447-.0644c.7524-.5706 1.6945-.8506 2.802-.8325.4091.0067.8017.0339 1.1742.081 1.939.3544 3.2439 1.4468 4.0359 2.3827.8143.9623 1.2552 1.9315 1.4312 2.4543-1.3232-.1346-2.2234.1268-2.6797.779-.9926 1.4189.543 4.1729 1.2811 5.4964.1353.2426.2522.4522.2889.5413.2403.5825.5515.9713.7787 1.2552.0696.087.1372.1714.1885.245-.4008.1155-1.1208.3825-1.0552 1.717-.0123.1563-.0423.4469-.0834.8148-.0461.2077-.0702.4603-.0994.7662zm.8905-1.6211c-.0405-.8316.2691-.9185.5967-1.0105a2.8566 2.8566 0 0 0 .135-.0406 1.202 1.202 0 0 0 .1342.103c.5703.3765 1.5823.4213 3.0068.1344-.2016.1769-.5189.3994-.9533.6011-.4098.1903-1.0957.333-1.7473.3636-.7197.0336-1.0859-.0807-1.1721-.151zm.5695-9.2712c-.0059.3508-.0542.6692-.1054 1.0017-.055.3576-.112.7274-.1264 1.1762-.0142.4368.0404.8909.0932 1.3301.1066.887.216 1.8003-.2075 2.7014a3.5272 3.5272 0 0 1-.1876-.3856c-.0527-.1276-.1669-.3326-.3251-.6162-.6156-1.1041-2.0574-3.6896-1.3193-4.7446.3795-.5427 1.3408-.5661 2.1781-.463zm.2284 7.0137a12.3762 12.3762 0 0 0-.0853-.1074l-.0355-.0444c.7262-1.1995.5842-2.3862.4578-3.4385-.0519-.4318-.1009-.8396-.0885-1.2226.0129-.4061.0666-.7543.1185-1.0911.0639-.415.1288-.8443.1109-1.3505.0134-.0531.0188-.1158.0118-.1902-.0457-.4855-.5999-1.938-1.7294-3.253-.6076-.7073-1.4896-1.4972-2.6889-2.0395.5251-.1066 1.2328-.2035 2.0244-.1859 2.0515.0456 3.6746.8135 4.8242 2.2824a.908.908 0 0 1 .0667.1002c.7231 1.3556-.2762 6.2751-2.9867 10.5405zm-8.8166-6.1162c-.025.1794-.3089.4225-.6211.4225a.5821.5821 0 0 1-.0809-.0056c-.1873-.026-.3765-.144-.5059-.3156-.0458-.0605-.1203-.178-.1055-.2844.0055-.0401.0261-.0985.0925-.1488.1182-.0894.3518-.1226.6096-.0867.3163.0441.6426.1938.6113.4186zm7.9305-.4114c.0111.0792-.049.201-.1531.3102-.0683.0717-.212.1961-.4079.2232a.5456.5456 0 0 1-.075.0052c-.2935 0-.5414-.2344-.5607-.3717-.024-.1765.2641-.3106.5611-.352.297-.0414.6111.0088.6356.1851z" />
    </svg>
  );
}

function MySqlLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path d="M16.405 5.501c-.115 0-.193.014-.274.033v.013h.014c.054.104.146.18.214.273.054.107.1.214.154.32l.014-.015c.094-.066.14-.172.14-.333-.04-.047-.046-.094-.08-.14-.04-.067-.126-.1-.18-.153zM5.77 18.695h-.927a50.854 50.854 0 00-.27-4.41h-.008l-1.41 4.41H2.45l-1.4-4.41h-.01a72.892 72.892 0 00-.195 4.41H0c.055-1.966.192-3.81.41-5.53h1.15l1.335 4.064h.008l1.347-4.064h1.095c.242 2.015.384 3.86.428 5.53zm4.017-4.08c-.378 2.045-.876 3.533-1.492 4.46-.482.716-1.01 1.073-1.583 1.073-.153 0-.34-.046-.566-.138v-.494c.11.017.24.026.386.026.268 0 .483-.075.647-.222.197-.18.295-.382.295-.605 0-.155-.077-.47-.23-.944L6.23 14.615h.91l.727 2.36c.164.536.233.91.205 1.123.4-1.064.678-2.227.835-3.483zm12.325 4.08h-2.63v-5.53h.885v4.85h1.745zm-3.32.135l-1.016-.5c.09-.076.177-.158.255-.25.433-.506.648-1.258.648-2.253 0-1.83-.718-2.746-2.155-2.746-.704 0-1.254.232-1.65.697-.43.508-.646 1.256-.646 2.245 0 .972.19 1.686.574 2.14.35.41.877.615 1.583.615.264 0 .506-.033.725-.098l1.325.772.36-.622zM15.5 17.588c-.225-.36-.337-.94-.337-1.736 0-1.393.424-2.09 1.27-2.09.443 0 .77.167.977.5.224.362.336.936.336 1.723 0 1.404-.424 2.108-1.27 2.108-.445 0-.77-.167-.978-.5zm-1.658-.425c0 .47-.172.856-.516 1.156-.344.3-.803.45-1.384.45-.543 0-1.064-.172-1.573-.515l.237-.476c.438.22.833.328 1.19.328.332 0 .593-.073.783-.22a.754.754 0 00.3-.615c0-.33-.23-.61-.648-.845-.388-.213-1.163-.657-1.163-.657-.422-.307-.632-.636-.632-1.177 0-.45.157-.81.47-1.085.315-.278.72-.415 1.22-.415.512 0 .98.136 1.4.41l-.213.476a2.726 2.726 0 00-1.064-.23c-.283 0-.502.068-.654.206a.685.685 0 00-.248.524c0 .328.234.61.666.85.393.215 1.187.67 1.187.67.433.305.648.63.648 1.168zm9.382-5.852c-.535-.014-.95.04-1.297.188-.1.04-.26.04-.274.167.055.053.063.14.11.214.08.134.218.313.346.407.14.11.28.216.427.31.26.16.555.255.81.416.145.094.293.213.44.313.073.05.12.14.214.172v-.02c-.046-.06-.06-.147-.105-.214-.067-.067-.134-.127-.2-.193a3.223 3.223 0 00-.695-.675c-.214-.146-.682-.35-.77-.595l-.013-.014c.146-.013.32-.066.46-.106.227-.06.435-.047.67-.106.106-.027.213-.06.32-.094v-.06c-.12-.12-.21-.283-.334-.395a8.867 8.867 0 00-1.104-.823c-.21-.134-.476-.22-.697-.334-.08-.04-.214-.06-.26-.127-.12-.146-.19-.34-.275-.514a17.69 17.69 0 01-.547-1.163c-.12-.262-.193-.523-.34-.763-.69-1.137-1.437-1.826-2.586-2.5-.247-.14-.543-.2-.856-.274-.167-.008-.334-.02-.5-.027-.11-.047-.216-.174-.31-.235-.38-.24-1.364-.76-1.644-.072-.18.434.267.862.422 1.082.115.153.26.328.34.5.047.116.06.235.107.356.106.294.207.622.347.897.073.14.153.287.247.413.054.073.146.107.167.227-.094.136-.1.334-.154.5-.24.757-.146 1.693.194 2.25.107.166.362.534.703.393.3-.12.234-.5.32-.835.02-.08.007-.133.048-.187v.015c.094.188.188.367.274.555.206.328.566.668.867.895.16.12.287.328.487.402v-.02h-.015c-.043-.058-.1-.086-.154-.133a3.445 3.445 0 01-.35-.4 8.76 8.76 0 01-.747-1.218c-.11-.21-.202-.436-.29-.643-.04-.08-.04-.2-.107-.24-.1.146-.247.273-.32.453-.127.288-.14.642-.188 1.01-.027.007-.014 0-.027.014-.214-.052-.287-.274-.367-.46-.2-.475-.233-1.238-.06-1.785.047-.14.247-.582.167-.716-.042-.127-.174-.2-.247-.303a2.478 2.478 0 01-.24-.427c-.16-.374-.24-.788-.414-1.162-.08-.173-.22-.354-.334-.513-.127-.18-.267-.307-.368-.52-.033-.073-.08-.194-.027-.274.014-.054.042-.075.094-.09.088-.072.335.022.422.062.247.1.455.194.662.334.094.066.195.193.315.226h.14c.214.047.455.014.655.073.355.114.675.28.962.46a5.953 5.953 0 012.085 2.286c.08.154.115.295.188.455.14.33.313.663.455.982.14.315.275.636.476.897.1.14.502.213.682.286.133.06.34.115.46.188.23.14.454.3.67.454.11.076.443.243.463.378z" />
    </svg>
  );
}

function MongoDbLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path d="M17.193 9.555c-1.264-5.58-4.252-7.414-4.573-8.115-.28-.394-.53-.954-.735-1.44-.036.495-.055.685-.523 1.184-.723.566-4.438 3.682-4.74 10.02-.282 5.912 4.27 9.435 4.888 9.884l.07.05A73.49 73.49 0 0111.91 24h.481c.114-1.032.284-2.056.51-3.07.417-.296.604-.463.85-.693a11.342 11.342 0 003.639-8.464c.01-.814-.103-1.662-.197-2.218zm-5.336 8.195s0-8.291.275-8.29c.213 0 .49 10.695.49 10.695-.381-.045-.765-1.76-.765-2.405z" />
    </svg>
  );
}

// Real official Supabase + Google BigQuery marks (path data + brand hex -
// Simple Icons project, MIT licensed - simpleicons.org), same provenance
// as the Postgres/MySQL/MongoDB marks above. Simple Icons has no entry for
// Microsoft SQL Server (it is not in that curated set), so that connector
// below reuses the generic DatabaseIcon outline tinted with Microsoft's own
// documented SQL Server brand red instead of an invented logo.
function SupabaseLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path d="M11.9 1.036c-.015-.986-1.26-1.41-1.874-.637L.764 12.05C-.33 13.427.65 15.455 2.409 15.455h9.579l.113 7.51c.014.985 1.259 1.408 1.873.636l9.262-11.653c1.093-1.375.113-3.403-1.645-3.403h-9.642z" />
    </svg>
  );
}

function BigQueryLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path d="M5.676 10.595h2.052v5.244a5.892 5.892 0 0 1-2.052-2.088v-3.156zm18.179 10.836a.504.504 0 0 1 0 .708l-1.716 1.716a.504.504 0 0 1-.708 0l-4.248-4.248a.206.206 0 0 1-.007-.007c-.02-.02-.028-.045-.043-.066a10.736 10.736 0 0 1-6.334 2.065C4.835 21.599 0 16.764 0 10.799S4.835 0 10.8 0s10.799 4.835 10.799 10.8c0 2.369-.772 4.553-2.066 6.333.025.017.052.028.074.05l4.248 4.248zm-5.028-10.632a8.015 8.015 0 1 0-8.028 8.028h.024a8.016 8.016 0 0 0 8.004-8.028zm-4.86 4.98a6.002 6.002 0 0 0 2.04-2.184v-1.764h-2.04v3.948zm-4.5.948c.442.057.887.08 1.332.072.4.025.8.025 1.2 0V7.692H9.468v9.035z" />
    </svg>
  );
}

// Generic line-art icon (not a brand mark) used both as the "Data
// warehouse" section header icon in StoredDataSection.tsx and anywhere
// else a neutral warehouse glyph is useful - matches DatabaseIcon/
// FileSpreadsheetIcon's own line-art style below so all three section
// icons read as one consistent set.
export function WarehouseIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 21V10l9-6 9 6v11" />
      <path d="M3 21h18" />
      <path d="M8 21v-6h8v6" />
      <path d="M8 12h.01M12 12h.01M16 12h.01" />
    </svg>
  );
}

export function DatabaseIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v6c0 1.66 3.58 3 8 3s8-1.34 8-3V5" />
      <path d="M4 11v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6" />
    </svg>
  );
}

export function FileSpreadsheetIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
      <path d="M8 13h8M8 17h8M8 13v4" />
    </svg>
  );
}

function ShieldIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2l8 4v6c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6z" />
    </svg>
  );
}

export function ChevronRightIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

function CopyIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </svg>
  );
}

export function CheckIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

function SpinnerIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" strokeOpacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function CloseIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  );
}

export function TableIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 9h18M3 15h18M9 3v18" />
    </svg>
  );
}

// Turns the epoch-seconds timestamp the backend returns into a short,
// human "Xm ago" - separate from Dashboard.tsx's timeAgo, which takes an
// ISO date string instead.
function timeAgoShort(epochSeconds: number): string {
  const diffMs = Date.now() - epochSeconds * 1000;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

const DB_KINDS = [
  { value: "postgres", label: "PostgreSQL", defaultPort: 5432, color: "#4169E1", Logo: PostgresLogo },
  { value: "mysql", label: "MySQL / MariaDB", defaultPort: 3306, color: "#4479A1", Logo: MySqlLogo },
  // Microsoft's own documented SQL Server brand red, paired with the
  // generic database outline (see the note above DatabaseIcon/WarehouseIcon
  // for why - Simple Icons has no SQL Server mark to draw exactly).
  { value: "sqlserver", label: "Microsoft SQL Server", defaultPort: 1433, color: "#CC2927", Logo: DatabaseIcon },
  { value: "mongodb", label: "MongoDB", defaultPort: 27017, color: "#47A248", Logo: MongoDbLogo },
  // Supabase's database IS Postgres under the hood (see connectors.py's
  // _sql_engine_url) - this tile exists purely so people recognize it by
  // its own name/logo instead of having to know that. Defaults to the
  // *pooler* port (6543), not Postgres's usual 5432: GD360's servers can
  // only reach a Supabase project through its connection pooler (see the
  // hint shown once this kind is selected, below).
  { value: "supabase", label: "Supabase", defaultPort: 6543, color: "#3FCF8E", Logo: SupabaseLogo },
];

// The one warehouse kind today; structured as a list (like DB_KINDS) so
// more can be added later (Snowflake, Redshift, ...) without reshaping
// anything that reads from it.
const WAREHOUSE_KINDS = [
  { value: "bigquery", label: "Google BigQuery", color: "#669DF6", Logo: BigQueryLogo },
];

// Same shape the backend's DataSourceOut returns. Exported so other
// components (e.g. the "Your data sources" homepage section) that also
// render a connected datasource share this one definition instead of
// redeclaring it.
export type CreatedDataSource = {
  id: string;
  name: string;
  kind: string;
  created_at: string;
  schema_cache?: Record<string, unknown> | null;
};

// Icon + label + brand color for a kind that might be a database (in
// DB_KINDS) or a file upload (csv/excel, which never appear in DB_KINDS
// since that picker is database-only). Exported for reuse anywhere else in
// the app that displays a data source's kind (currently: the "Connected"
// confirmation panel below, and the "Your data sources" homepage section).
export function connectionKindMeta(kind: string) {
  const found = DB_KINDS.find((d) => d.value === kind) || WAREHOUSE_KINDS.find((w) => w.value === kind);
  if (found) return { label: found.label, color: found.color, Logo: found.Logo };
  if (kind === "excel") return { label: "Excel file", color: "#1D6F42", Logo: FileSpreadsheetIcon };
  return { label: "CSV file", color: "#64748b", Logo: FileSpreadsheetIcon };
}

// Normalizes the three different shapes `schema_cache` can come back in
// (SQL: { table: [{name,type}] }, MongoDB: { collection: ["field", ...] },
// file upload: { columns: [{name,type}] }) into one consistent list any
// panel can render the same way regardless of kind. Exported for reuse
// (currently: the "Connected" confirmation panel below, and the "Your data
// sources" homepage section's per-source schema preview).
export function getTableEntries(
  kind: string,
  schemaCache: Record<string, unknown> | null | undefined,
  fallbackName: string
): { name: string; columns: { name: string; type?: string }[] }[] {
  if (!schemaCache) return [];
  if (kind === "csv" || kind === "excel") {
    const cols = Array.isArray((schemaCache as any).columns) ? (schemaCache as any).columns : [];
    return [{ name: fallbackName, columns: cols }];
  }
  return Object.entries(schemaCache).map(([tableName, cols]) => {
    if (Array.isArray(cols) && (cols.length === 0 || typeof cols[0] === "string")) {
      // MongoDB: a plain array of field name strings.
      return { name: tableName, columns: (cols as string[]).map((f) => ({ name: f })) };
    }
    return { name: tableName, columns: (cols as { name: string; type: string }[]) || [] };
  });
}

// `onCreated` is handed the datasource the server just created (id, name,
// kind, created_at) once the person confirms in the "Connected" panel that
// they want to jump into it - the homepage uses that id to jump straight
// into its workspace, since there is no dataset grid to click into any
// more. `onConnected` (optional) fires immediately on a successful
// connect/upload, before that confirmation, so the parent can quietly
// refresh its own lists in the background without navigating away yet.
export default function DataSourceForm({
  onCreated,
  onConnected,
}: {
  onCreated: (ds: { id: string; name: string; kind: string; created_at: string }) => void;
  onConnected?: (ds: CreatedDataSource) => void;
}) {
  const [mode, setMode] = useState<"db" | "warehouse" | "file">("db");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // DB form state
  const [kind, setKind] = useState("postgres");
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState(5432);
  const [database, setDatabase] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [ssl, setSsl] = useState(true);

  // Data warehouse: unlike the database picker above (which selects a kind
  // inline and shows one shared form below it), a warehouse tile opens its
  // own popout form on click - warehouseModalKind holds which warehouse
  // kind's popout is open (null = closed). Kept as its own small form
  // rather than folded into the DB form above since BigQuery authenticates
  // completely differently (a service-account key, not host/port/username/
  // password) and has nothing in common with it field-for-field.
  const [warehouseModalKind, setWarehouseModalKind] = useState<string | null>(null);
  const [whName, setWhName] = useState("");
  const [projectId, setProjectId] = useState("");
  const [datasetId, setDatasetId] = useState("");
  const [serviceAccountJson, setServiceAccountJson] = useState("");

  // File form state
  const [fileName, setFileName] = useState("");
  const [file, setFile] = useState<File | null>(null);

  // "Connected" confirmation panel: shown right after a successful connect
  // or upload, before handing off to the workspace, so the person can see
  // exactly what GD360 found (which tables/collections/columns) and confirm
  // it's the right thing before diving into chat - real-time confirmation
  // instead of a blind jump straight into the workspace.
  const [connectedDs, setConnectedDs] = useState<CreatedDataSource | null>(null);
  const [expandedTables, setExpandedTables] = useState<Record<string, boolean>>({});

  // "Show IPs to whitelist": some managed databases (AWS RDS, GCP Cloud
  // SQL, MongoDB Atlas, and similar) only accept connections from an
  // allowed list of IP addresses. ipData holds whatever the backend has
  // genuinely, live-observed as this server's own outbound address(es) -
  // see GET /datasources/network/outbound-ips - never a hardcoded guess.
  const [showIps, setShowIps] = useState(false);
  const [ipData, setIpData] = useState<{ ips: string[]; checked_at: number | null } | null>(null);
  const [ipLoading, setIpLoading] = useState(false);
  const [ipError, setIpError] = useState("");
  const [copied, setCopied] = useState(false);

  const fetchOutboundIps = async (refresh = false) => {
    setIpLoading(true);
    setIpError("");
    try {
      const { data } = await api.get(`/datasources/network/outbound-ips${refresh ? "?refresh=true" : ""}`);
      setIpData(data);
    } catch (err: any) {
      setIpError(err?.response?.data?.detail || "Could not reach GD360's server to detect its outbound address.");
    } finally {
      setIpLoading(false);
    }
  };

  const toggleShowIps = () => {
    const next = !showIps;
    setShowIps(next);
    if (next && !ipData && !ipLoading) fetchOutboundIps();
  };

  const copyIps = async () => {
    if (!ipData?.ips?.length) return;
    try {
      await navigator.clipboard.writeText(ipData.ips.join(", "));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API can be blocked in some browser contexts - fail
      // quietly, the addresses are still visible and selectable by hand.
    }
  };

  const selectDbKind = (value: string) => {
    setKind(value);
    const found = DB_KINDS.find((d) => d.value === value);
    if (found) setPort(found.defaultPort);
  };

  // Shared by both submit handlers: shows the "Connected" confirmation panel
  // instead of jumping straight to the workspace, and auto-expands it when
  // there's only a single table/file (nothing to choose between, so no
  // point making the person click to see its columns).
  const showConnectedPanel = (data: CreatedDataSource) => {
    setConnectedDs(data);
    const entries = getTableEntries(data.kind, data.schema_cache, data.name);
    setExpandedTables(entries.length === 1 ? { [entries[0].name]: true } : {});
    onConnected?.(data);
  };

  const submitDb = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const { data } = await api.post("/datasources/database", { name, kind, host, port, database, username, password, ssl });
      setName(""); setHost(""); setDatabase(""); setUsername(""); setPassword("");
      showConnectedPanel(data);
    } catch (err: any) {
      setError(err?.response?.data?.detail || "Could not connect. Check your credentials and network access.");
    } finally {
      setBusy(false);
    }
  };

  const openWarehouseForm = (value: string) => {
    setWarehouseModalKind(value);
    setWhName("");
    setProjectId("");
    setDatasetId("");
    setServiceAccountJson("");
    setError("");
  };

  const closeWarehouseForm = () => {
    setWarehouseModalKind(null);
    setError("");
  };

  const submitWarehouse = async (e: FormEvent) => {
    e.preventDefault();
    if (!warehouseModalKind) return;
    setBusy(true);
    setError("");
    try {
      const { data } = await api.post("/datasources/warehouse", {
        name: whName,
        kind: warehouseModalKind,
        project_id: projectId,
        dataset_id: datasetId,
        service_account_json: serviceAccountJson,
      });
      setWhName(""); setProjectId(""); setDatasetId(""); setServiceAccountJson("");
      setWarehouseModalKind(null);
      showConnectedPanel(data);
    } catch (err: any) {
      setError(err?.response?.data?.detail || "Could not connect. Check your project ID, dataset, and service account key.");
    } finally {
      setBusy(false);
    }
  };

  const submitFile = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const form = new FormData();
      form.append("name", fileName || file.name);
      form.append("file", file);
      const { data } = await api.post("/datasources/file", form, { headers: { "Content-Type": "multipart/form-data" } });
      setFileName(""); setFile(null);
      showConnectedPanel(data);
    } catch (err: any) {
      setError(err?.response?.data?.detail || "Could not read file.");
    } finally {
      setBusy(false);
    }
  };

  const closeConnectedPanel = () => setConnectedDs(null);

  const proceedToWorkspace = () => {
    if (connectedDs) onCreated(connectedDs);
    setConnectedDs(null);
  };

  const toggleTableExpanded = (tableName: string) => {
    setExpandedTables((prev) => ({ ...prev, [tableName]: !prev[tableName] }));
  };

  const connectedTableEntries = connectedDs ? getTableEntries(connectedDs.kind, connectedDs.schema_cache, connectedDs.name) : [];
  const connectedMeta = connectedDs ? connectionKindMeta(connectedDs.kind) : null;

  return (
    <>
    <div className="card p-6">
      <div className="flex flex-wrap gap-2 mb-5">
        <button
          className={`px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-1.5 ${mode === "db" ? "bg-primary text-white" : "btn-secondary"}`}
          onClick={() => setMode("db")}
        >
          <DatabaseIcon className="w-4 h-4" /> Connect a database
        </button>
        <button
          className={`px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-1.5 ${mode === "warehouse" ? "bg-primary text-white" : "btn-secondary"}`}
          onClick={() => setMode("warehouse")}
        >
          <WarehouseIcon className="w-4 h-4" /> Connect a data warehouse
        </button>
        <button
          className={`px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-1.5 ${mode === "file" ? "bg-primary text-white" : "btn-secondary"}`}
          onClick={() => setMode("file")}
        >
          <FileSpreadsheetIcon className="w-4 h-4" /> Upload CSV / Excel
        </button>
      </div>

      {error && !warehouseModalKind && (
        <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 mb-4">{error}</div>
      )}

      {mode === "db" ? (
        <div>
          {/* Connector picker: a real, recognizable logo per database type
              with just its name underneath - no extra copy or tags - so
              people can identify their database at a glance the same way a
              polished connector gallery works. */}
          <div className="grid grid-cols-3 sm:grid-cols-5 gap-3 mb-5">
            {DB_KINDS.map((d) => {
              const selected = kind === d.value;
              return (
                <button
                  type="button"
                  key={d.value}
                  aria-pressed={selected}
                  onClick={() => selectDbKind(d.value)}
                  className={`relative flex flex-col items-center justify-center gap-1.5 py-4 rounded-xl border transition ${
                    selected ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-border hover:border-primary/40"
                  }`}
                >
                  <div
                    className="w-11 h-11 rounded-lg flex items-center justify-center"
                    style={{ backgroundColor: `${d.color}1a`, color: d.color }}
                  >
                    <d.Logo className="w-6 h-6" />
                  </div>
                  <span className="text-xs font-medium text-muted text-center leading-tight px-1">{d.label}</span>
                  {selected && (
                    <span
                      className="absolute top-1.5 right-1.5 w-4 h-4 rounded-full bg-primary text-white flex items-center justify-center text-[10px] leading-none"
                      aria-hidden
                    >
                      &#10003;
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {kind === "supabase" && (
            <div className="text-xs text-muted bg-surface2 border border-border rounded-lg p-3 mb-5 leading-relaxed">
              Use Supabase's <strong>Connection pooling</strong> details (Project Settings &rarr; Database &rarr;
              Connection pooling), not the direct connection - GD360's servers can only reach Supabase through the
              pooler host (something like <code className="font-mono">aws-0-&lt;region&gt;.pooler.supabase.com</code>,
              port 6543).
            </div>
          )}

          <form onSubmit={submitDb} className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="sm:col-span-2">
              <label className="text-sm text-muted mb-1 block">Connection name</label>
              <input className="input" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Production Postgres" />
            </div>
            <div>
              <label className="text-sm text-muted mb-1 block">Host</label>
              <input className="input" required value={host} onChange={(e) => setHost(e.target.value)} placeholder="db.example.com" />
            </div>
            <div>
              <label className="text-sm text-muted mb-1 block">Port</label>
              <input className="input" required type="number" value={port} onChange={(e) => setPort(Number(e.target.value))} />
            </div>
            <div>
              <label className="text-sm text-muted mb-1 block">Database name</label>
              <input className="input" required value={database} onChange={(e) => setDatabase(e.target.value)} />
            </div>
            <div>
              <label className="text-sm text-muted mb-1 block">Username</label>
              <input className="input" required value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Read-only user recommended" />
            </div>
            <div>
              <label className="text-sm text-muted mb-1 block">Password</label>
              <input className="input" required type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            {kind === "sqlserver" ? (
              <div className="text-xs text-muted mt-1 sm:col-span-2 sm:mt-0 flex items-center">
                Encryption is negotiated automatically for SQL Server - no toggle needed here.
              </div>
            ) : (
              <div className="flex items-center gap-2 mt-6">
                <input id="ssl" type="checkbox" checked={ssl} onChange={(e) => setSsl(e.target.checked)} />
                <label htmlFor="ssl" className="text-sm text-muted">Require SSL/TLS</label>
              </div>
            )}
            <div className="sm:col-span-2 text-xs text-muted bg-surface2 border border-border rounded-lg p-3">
              Read-only, always. GD360 never modifies your data, and your password is encrypted. Tip: use a
              read-only database user for extra safety.
            </div>

            {/* ---- IP allow-listing: some managed databases only accept connections
                from a list of allowed addresses, so this shows this server's real,
                live-detected outbound IP(s) for the person to add there. ---- */}
            <div className="sm:col-span-2">
              <div className="flex items-start gap-2 text-xs text-muted mb-2">
                <ShieldIcon className="w-4 h-4 mt-0.5 shrink-0 text-accent" />
                <span>
                  Some databases only accept connections from approved IP addresses. If yours does,
                  whitelist GD360's addresses below.
                </span>
              </div>
              <button
                type="button"
                onClick={toggleShowIps}
                className="text-xs font-medium text-primary flex items-center gap-1 hover:underline"
              >
                <ChevronRightIcon className={`w-3.5 h-3.5 transition-transform ${showIps ? "rotate-90" : ""}`} />
                {showIps ? "Hide IPs to whitelist" : "Show IPs to whitelist"}
              </button>

              {showIps && (
                <div className="mt-3 rounded-lg border border-border bg-surface2 p-4">
                  {ipLoading ? (
                    <div className="text-xs text-muted flex items-center gap-2">
                      <SpinnerIcon className="w-3.5 h-3.5 animate-spin" /> Detecting GD360's live outbound addresses...
                    </div>
                  ) : ipError ? (
                    <div className="text-xs text-red-400 flex items-center justify-between gap-3">
                      <span>{ipError}</span>
                      <button type="button" onClick={() => fetchOutboundIps(true)} className="text-primary font-medium hover:underline shrink-0">
                        Retry
                      </button>
                    </div>
                  ) : ipData && ipData.ips.length > 0 ? (
                    <>
                      <div className="flex items-start justify-between gap-3">
                        <div className="font-mono text-sm leading-relaxed break-all">
                          {ipData.ips.map((ip) => (
                            <div key={ip}>{ip}</div>
                          ))}
                        </div>
                        <button
                          type="button"
                          onClick={copyIps}
                          title="Copy to clipboard"
                          className="shrink-0 w-8 h-8 rounded-lg border border-border flex items-center justify-center text-muted hover:text-primary hover:border-primary/40 transition"
                        >
                          {copied ? <CheckIcon className="w-4 h-4 text-accent" /> : <CopyIcon className="w-4 h-4" />}
                        </button>
                      </div>
                      <div className="flex items-center justify-between mt-3 pt-3 border-t border-border">
                        <span className="text-[11px] text-muted">
                          Live-detected from GD360's own servers
                          {ipData.checked_at ? ` · updated ${timeAgoShort(ipData.checked_at)}` : ""}
                        </span>
                        <button type="button" onClick={() => fetchOutboundIps(true)} className="text-[11px] text-primary font-medium hover:underline">
                          Refresh
                        </button>
                      </div>
                    </>
                  ) : (
                    <div className="text-xs text-muted flex items-center justify-between gap-3">
                      <span>Could not detect any addresses just now.</span>
                      <button type="button" onClick={() => fetchOutboundIps(true)} className="text-primary font-medium hover:underline shrink-0">
                        Try again
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="sm:col-span-2">
              <button className="btn-primary" type="submit" disabled={busy}>{busy ? "Connecting..." : "Test & connect"}</button>
            </div>
          </form>
        </div>
      ) : mode === "warehouse" ? (
        <div>
          {/* Icon-only picker: no inline form beneath it. Clicking a tile
              opens that warehouse's own popout form below instead - a data
              warehouse's fields (project/dataset/service-account key) have
              nothing in common with the database form above, so there is no
              shared form to switch into here the way DB_KINDS does. */}
          <div className="grid grid-cols-3 sm:grid-cols-5 gap-3">
            {WAREHOUSE_KINDS.map((w) => (
              <button
                type="button"
                key={w.value}
                onClick={() => openWarehouseForm(w.value)}
                className="relative flex flex-col items-center justify-center gap-1.5 py-4 rounded-xl border border-border hover:border-primary/40 transition"
              >
                <div
                  className="w-11 h-11 rounded-lg flex items-center justify-center"
                  style={{ backgroundColor: `${w.color}1a`, color: w.color }}
                >
                  <w.Logo className="w-6 h-6" />
                </div>
                <span className="text-xs font-medium text-muted text-center leading-tight px-1">{w.label}</span>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <form onSubmit={submitFile} className="space-y-4">
          <div>
            <label className="text-sm text-muted mb-1 block">Name</label>
            <input className="input" value={fileName} onChange={(e) => setFileName(e.target.value)} placeholder="Q3 sales export" />
          </div>
          <div>
            <label className="text-sm text-muted mb-1 block">File (.csv, .xlsx, .xls)</label>
            <input className="input" type="file" accept=".csv,.xlsx,.xls" required onChange={(e) => setFile(e.target.files?.[0] || null)} />
          </div>
          <button className="btn-primary" type="submit" disabled={busy}>{busy ? "Uploading..." : "Upload"}</button>
        </form>
      )}
    </div>

    {/* ---- Data warehouse popout: the picker tile above only ever opens
        this - a small, self-contained form for that one warehouse kind's
        very different credential shape (project/dataset/service-account
        key, not host/port/username/password), plus a link to a dedicated
        step-by-step guide for actually getting those values, since nothing
        else in this app walks someone through a GCP console. ---- */}
    {warehouseModalKind && (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={closeWarehouseForm} aria-hidden />
        <div className="relative card bg-surface w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto" role="dialog" aria-modal="true">
          <button
            type="button"
            onClick={closeWarehouseForm}
            aria-label="Close"
            className="absolute top-4 right-4 text-muted hover:text-text transition"
          >
            <CloseIcon className="w-4 h-4" />
          </button>

          <div className="flex items-start justify-between gap-3 pr-6">
            <div className="flex items-center gap-3">
              <div
                className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"
                style={{
                  backgroundColor: `${connectionKindMeta(warehouseModalKind).color}1a`,
                  color: connectionKindMeta(warehouseModalKind).color,
                }}
              >
                {(() => {
                  const WLogo = connectionKindMeta(warehouseModalKind).Logo;
                  return <WLogo className="w-5 h-5" />;
                })()}
              </div>
              <div className="font-bold text-lg leading-tight">Connect {connectionKindMeta(warehouseModalKind).label}</div>
            </div>
          </div>

          {/* The "side" link the person asked for - opens the dedicated
              step-by-step guide in a new browser tab, so filling this form
              out never means losing their place in it. */}
          
            <a href="/help/connect-bigquery"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
          >
            How to connect BigQuery to GD360
            <ChevronRightIcon className="w-3 h-3" />
          </a>

          {error && (
            <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 mt-4">{error}</div>
          )}

          <form onSubmit={submitWarehouse} className="grid grid-cols-1 gap-4 mt-4">
            <div>
              <label className="text-sm text-muted mb-1 block">Connection name</label>
              <input className="input" required value={whName} onChange={(e) => setWhName(e.target.value)} placeholder="Production BigQuery" />
            </div>
            <div>
              <label className="text-sm text-muted mb-1 block">Project ID</label>
              <input className="input" required value={projectId} onChange={(e) => setProjectId(e.target.value)} placeholder="my-gcp-project-123" />
            </div>
            <div>
              <label className="text-sm text-muted mb-1 block">Dataset ID</label>
              <input className="input" required value={datasetId} onChange={(e) => setDatasetId(e.target.value)} placeholder="analytics" />
            </div>
            <div>
              <label className="text-sm text-muted mb-1 block">Service account key (JSON)</label>
              <textarea
                className="input font-mono text-xs"
                rows={6}
                required
                value={serviceAccountJson}
                onChange={(e) => setServiceAccountJson(e.target.value)}
                placeholder='{ "type": "service_account", "project_id": "...", ... }'
              />
            </div>
            <div className="text-xs text-muted bg-surface2 border border-border rounded-lg p-3">
              Read-only, always. GD360 only ever runs SELECT queries against BigQuery, and your service account
              key is encrypted at rest. Tip: create a service account with only the <strong>BigQuery Data
              Viewer</strong> and <strong>BigQuery Job User</strong> roles for extra safety.
            </div>
            <div className="flex items-center gap-3">
              <button type="button" className="btn-secondary flex-1" onClick={closeWarehouseForm}>
                Cancel
              </button>
              <button className="btn-primary flex-1" type="submit" disabled={busy}>
                {busy ? "Connecting..." : "Test & connect"}
              </button>
            </div>
          </form>
        </div>
      </div>
    )}

    {/* ---- "Connected" confirmation: shown right after a successful connect
        or upload, before handing off to the workspace, so the person gets
        real-time confirmation of exactly what they connected and what
        GD360 can see in it - never a blind jump straight into chat. ---- */}
    {connectedDs && connectedMeta && (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={closeConnectedPanel} aria-hidden />
        <div className="relative card bg-surface w-full max-w-md p-6 max-h-[85vh] overflow-y-auto" role="dialog" aria-modal="true">
          <button
            type="button"
            onClick={closeConnectedPanel}
            aria-label="Close"
            className="absolute top-4 right-4 text-muted hover:text-text transition"
          >
            <CloseIcon className="w-4 h-4" />
          </button>

          <div className="flex items-center gap-3 pr-6">
            <div className="w-10 h-10 rounded-full bg-accent/15 flex items-center justify-center text-accent shrink-0">
              <CheckIcon className="w-5 h-5" />
            </div>
            <div>
              <div className="font-bold text-lg leading-tight">Connected</div>
              <div className="text-xs text-muted mt-0.5">Your data source connected successfully.</div>
            </div>
          </div>

          <div className="mt-5 rounded-lg border border-border bg-surface2 p-3 flex items-center gap-3">
            <div
              className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
              style={{ backgroundColor: `${connectedMeta.color}1a`, color: connectedMeta.color }}
            >
              <connectedMeta.Logo className="w-5 h-5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-medium text-sm truncate">{connectedDs.name}</div>
              <div className="text-xs text-muted">Connected to {connectedMeta.label}</div>
            </div>
            <CheckIcon className="w-4 h-4 text-accent shrink-0" />
          </div>

          <div className="mt-5">
            <div className="text-sm font-semibold mb-1">Available data</div>
            <div className="text-xs text-muted mb-3 leading-relaxed">
              {connectedTableEntries.length > 0
                ? "Here's what GD360 found - ask about any of it."
                : "Connected, but GD360 didn't find any tables to read yet."}
            </div>

            {connectedTableEntries.length > 0 && (
              <div className="space-y-1.5">
                {connectedTableEntries.map((entry) => (
                  <div key={entry.name} className="rounded-lg border border-border overflow-hidden">
                    <button
                      type="button"
                      onClick={() => toggleTableExpanded(entry.name)}
                      className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-surface2 transition"
                    >
                      <ChevronRightIcon
                        className={`w-3.5 h-3.5 shrink-0 text-muted transition-transform ${expandedTables[entry.name] ? "rotate-90" : ""}`}
                      />
                      <TableIcon className="w-3.5 h-3.5 shrink-0 text-muted" />
                      <span className="text-sm font-medium truncate flex-1">{entry.name}</span>
                      <span className="text-[11px] text-muted shrink-0">
                        {entry.columns.length} col{entry.columns.length === 1 ? "" : "s"}
                      </span>
                    </button>
                    {expandedTables[entry.name] && (
                      <div className="px-3 pb-2.5 pt-0.5 flex flex-wrap gap-1.5 bg-surface2">
                        {entry.columns.length > 0 ? (
                          entry.columns.map((c) => (
                            <span
                              key={c.name}
                              className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-base border border-border text-muted"
                            >
                              {c.name}
                            </span>
                          ))
                        ) : (
                          <span className="text-[11px] text-muted">No columns detected.</span>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="flex items-center gap-3 mt-6">
            <button type="button" className="btn-secondary flex-1" onClick={closeConnectedPanel}>
              Close
            </button>
            <button type="button" className="btn-primary flex-1" onClick={proceedToWorkspace}>
              Try it out &rarr;
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}
