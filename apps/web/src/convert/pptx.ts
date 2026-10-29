// PDF → PowerPoint: one slide per page. The page's pictures and drawings
// become the slide background and its text becomes editable text boxes in
// the same places.
import type { PageLayout } from "@paperless/pdf-engine";
import { contentTypes, coreProperties, emu, escapeXml, hexColor, packageRelationships, writePackage, XML_HEADER, type PackagePart } from "./ooxml";
import { bodySize, structurePage, type Paragraph, type Run } from "./structure";

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const EMPTY_TREE = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

const runXml = (run: Run, scale: number) =>
  "tab" in run
    ? "<a:r><a:rPr lang=\"en-US\" dirty=\"0\"/><a:t>\t</a:t></a:r>"
    : `<a:r><a:rPr lang="en-US" sz="${Math.max(100, Math.round(run.size * scale * 100))}"${run.bold ? ' b="1"' : ""}${run.italic ? ' i="1"' : ""} dirty="0"><a:solidFill><a:srgbClr val="${hexColor(run.color)}"/></a:solidFill><a:latin typeface="${escapeXml(run.font)}"/><a:cs typeface="${escapeXml(run.font)}"/></a:rPr><a:t>${escapeXml(run.text)}</a:t></a:r>`;

function textBox(paragraph: Paragraph, id: number, scale: number, slideWidth: number) {
  const multiLine = paragraph.lines.length > 1;
  const algn = { left: "l", center: "ctr", right: "r", justify: "just" }[paragraph.alignment];
  // A little slack keeps substitute fonts from wrapping earlier than the original.
  const slack = multiLine ? paragraph.width * 0.04 : paragraph.width * 0.15 + paragraph.size;
  const width = Math.min(slideWidth / scale - paragraph.x, paragraph.width + slack);
  const x = paragraph.alignment === "right" ? paragraph.x - slack : paragraph.alignment === "center" ? paragraph.x - slack / 2 : paragraph.x;
  const spacing = multiLine ? `<a:lnSpc><a:spcPts val="${Math.round(paragraph.lineGap * scale * 100)}"/></a:lnSpc>` : "";
  const tabs = paragraph.tabs.length ? `<a:tabLst>${paragraph.tabs.map((tab) => `<a:tab pos="${emu((tab - x) * scale)}" algn="l"/>`).join("")}</a:tabLst>` : "";
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Text ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${emu(Math.max(0, x) * scale)}" y="${emu(paragraph.y * scale)}"/><a:ext cx="${emu(width * scale)}" cy="${emu(paragraph.height * scale)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="${multiLine ? "square" : "none"}" lIns="0" tIns="0" rIns="0" bIns="0" anchor="t"><a:noAutofit/></a:bodyPr><a:lstStyle/><a:p><a:pPr algn="${algn}">${spacing}${tabs}</a:pPr>${paragraph.runs.map((run) => runXml(run, scale)).join("")}</a:p></p:txBody></p:sp>`;
}

const THEME = `${XML_HEADER}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Paperless"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`;

const MASTER = `${XML_HEADER}<p:sldMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${EMPTY_TREE}</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="4400"/></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>`;

const LAYOUT = `${XML_HEADER}<p:sldLayout ${NS} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${EMPTY_TREE}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;

const relationships = (items: [string, string, string][]) =>
  `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.map(([id, type, target]) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`).join("")}</Relationships>`;

/**
 * `backgrounds` holds each page rendered without its text (PNG); slides take
 * the size of the first page and other pages are scaled to fit.
 */
export async function buildPptx(layouts: PageLayout[], backgrounds: Uint8Array[], title: string) {
  const body = bodySize(layouts);
  const first = layouts[0] ?? { width: 720, height: 540 };
  // PowerPoint allows slides from 1 to 56 inches.
  const slideWidth = Math.min(4032, Math.max(72, first.width));
  const slideHeight = Math.min(4032, Math.max(72, first.height));
  const media: PackagePart[] = [];
  const slides = layouts.map((layout, index) => {
    const scale = Math.min(slideWidth / layout.width, slideHeight / layout.height);
    const page = structurePage(layout, body);
    const paragraphs = page.items.flatMap((item) => (item.kind === "paragraph" ? [item] : item.kind === "table" ? item.cells.flat(2) : []));
    let id = 2;
    const shapes = paragraphs.map((paragraph) => textBox(paragraph, id++, scale, slideWidth)).join("");
    const background = backgrounds[index];
    if (background) media.push({ name: `ppt/media/page${index + 1}.png`, data: background, compress: false });
    const bg = background
      ? '<p:bg><p:bgPr><a:blipFill dpi="0" rotWithShape="1"><a:blip r:embed="rIdBackground"/><a:srcRect/><a:stretch><a:fillRect/></a:stretch></a:blipFill><a:effectLst/></p:bgPr></p:bg>'
      : "";
    return {
      xml: `${XML_HEADER}<p:sld ${NS}><p:cSld>${bg}<p:spTree>${EMPTY_TREE}${shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`,
      rels: relationships([
        ["rIdLayout", "slideLayout", "../slideLayouts/slideLayout1.xml"],
        ...(background ? [["rIdBackground", "image", `../media/page${index + 1}.png`] as [string, string, string]] : []),
      ]),
    };
  });

  const presentation = `${XML_HEADER}<p:presentation ${NS} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rIdMaster"/></p:sldMasterIdLst><p:sldIdLst>${slides
    .map((_, index) => `<p:sldId id="${256 + index}" r:id="rIdSlide${index + 1}"/>`)
    .join("")}</p:sldIdLst><p:sldSz cx="${emu(slideWidth)}" cy="${emu(slideHeight)}"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:defaultTextStyle></p:presentation>`;
  const presentationRels = relationships([
    ["rIdMaster", "slideMaster", "slideMasters/slideMaster1.xml"],
    ["rIdTheme", "theme", "theme/theme1.xml"],
    ["rIdProps", "presProps", "presProps.xml"],
    ["rIdView", "viewProps", "viewProps.xml"],
    ["rIdTableStyles", "tableStyles", "tableStyles.xml"],
    ...slides.map((_, index): [string, string, string] => [`rIdSlide${index + 1}`, "slide", `slides/slide${index + 1}.xml`]),
  ]);
  const P = "application/vnd.openxmlformats-officedocument.presentationml";
  return writePackage([
    {
      name: "[Content_Types].xml",
      data: contentTypes(
        [
          ["/ppt/presentation.xml", `${P}.presentation.main+xml`],
          ["/ppt/slideMasters/slideMaster1.xml", `${P}.slideMaster+xml`],
          ["/ppt/slideLayouts/slideLayout1.xml", `${P}.slideLayout+xml`],
          ["/ppt/theme/theme1.xml", "application/vnd.openxmlformats-officedocument.theme+xml"],
          ["/ppt/presProps.xml", `${P}.presProps+xml`],
          ["/ppt/viewProps.xml", `${P}.viewProps+xml`],
          ["/ppt/tableStyles.xml", `${P}.tableStyles+xml`],
          ...slides.map((_, index): [string, string] => [`/ppt/slides/slide${index + 1}.xml`, `${P}.slide+xml`]),
        ],
        true,
      ),
    },
    { name: "_rels/.rels", data: packageRelationships({ type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument", target: "ppt/presentation.xml" }) },
    ...coreProperties(title, "Paperless PDF Editor"),
    { name: "ppt/presentation.xml", data: presentation },
    { name: "ppt/_rels/presentation.xml.rels", data: presentationRels },
    { name: "ppt/slideMasters/slideMaster1.xml", data: MASTER },
    { name: "ppt/slideMasters/_rels/slideMaster1.xml.rels", data: relationships([["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"], ["rId2", "theme", "../theme/theme1.xml"]]) },
    { name: "ppt/slideLayouts/slideLayout1.xml", data: LAYOUT },
    { name: "ppt/slideLayouts/_rels/slideLayout1.xml.rels", data: relationships([["rId1", "slideMaster", "../slideMasters/slideMaster1.xml"]]) },
    { name: "ppt/theme/theme1.xml", data: THEME },
    { name: "ppt/presProps.xml", data: `${XML_HEADER}<p:presentationPr ${NS}/>` },
    { name: "ppt/viewProps.xml", data: `${XML_HEADER}<p:viewPr ${NS}><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>` },
    { name: "ppt/tableStyles.xml", data: `${XML_HEADER}<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>` },
    ...slides.flatMap((slide, index) => [
      { name: `ppt/slides/slide${index + 1}.xml`, data: slide.xml },
      { name: `ppt/slides/_rels/slide${index + 1}.xml.rels`, data: slide.rels },
    ]),
    ...media,
  ]);
}
