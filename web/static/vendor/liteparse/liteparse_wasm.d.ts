/* tslint:disable */
/* eslint-disable */

export interface OcrEngine {
    recognize(imageData: Uint8Array, width: number, height: number, language: string): Promise<OcrResult[]>;
}

export interface LiteParseInit extends LiteParseConfig {
    ocrEngine?: OcrEngine;
}


/**
 * A page sub-region as the fraction cropped from each side (top-left origin,
 * each in `[0, 1]`).
 */
export interface CropBox {
    top?: number;
    right?: number;
    bottom?: number;
    left?: number;
}

/**
 * One raw packet from an XFA form document\'s `/XFA` array.
 */
export interface XfaPacket {
    index: number;
    name?: string;
    contentLength: number;
    /**
     * Packet content (usually XML), lossily decoded as UTF-8.
     */
    content?: string;
}

/**
 * Scalar value from a tagged-PDF structure element\'s `/A` dictionary.
 */
export type StructureAttributeValue = boolean | number | string;

export interface AnnotationRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface DocumentAnnotation {
    subtype: string;
    contents?: string;
    created?: string;
    modified?: string;
    title?: string;
    rect?: AnnotationRect;
    quadpointRects: AnnotationRect[];
    uri?: string;
}

export interface DocumentMetadata {
    creationDate?: string;
    modDate?: string;
    fileVersion?: number;
    isEncrypted?: boolean;
    securityHandlerRevision?: number;
    permissions?: number;
    eofSectionCount?: number;
    startxrefCount?: number;
    trailerIdPairDiffers?: boolean;
    rawFileSize?: number;
    xmp?: string;
    /**
     * True when the catalog\'s XMP stream exceeded the 64 KiB cap. WASM
     * builds never populate `xmp`, so this is always absent there.
     */
    xmpTruncated?: boolean;
    signatureCount?: number;
    signatureByteRangeReachesEof?: boolean;
}

export interface ExtractedImage {
    id: string;
    name: string;
    path: string | undefined;
    page: number;
    bbox: ImageRect;
    width: number;
    height: number;
    rotation: number;
    format: string;
    duplicateOf: string | undefined;
    /**
     * Raw image bytes, serialized as a JS `number[]`. Callers that want a
     * Uint8Array can wrap with `new Uint8Array(image.bytes)`.
     */
    bytes: number[];
}

export interface FormField {
    id: string;
    type: string;
    page: number;
    annotationIndex: number;
    widgetIndex: number;
    objectNumber: number | undefined;
    name: string | undefined;
    alternateName: string | undefined;
    value: string | undefined;
    exportValue: string | undefined;
    fieldFlags: number;
    controlCount: number | undefined;
    controlIndex: number | undefined;
    checked: boolean | undefined;
    rect: AnnotationRect | undefined;
    options: string[];
    selectedOptions: string[];
}

export interface ImageRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface LayoutComplexityStats {
    columnCount: number;
    ruledTableCount: number;
    ruledTableCoverage: number;
    textTableRunCount: number;
    figureCount: number;
    figureCoverage: number;
    isComplex: boolean;
    reasons: string[];
}

export interface LiteParseConfig {
    ocrLanguage?: string | undefined;
    ocrEnabled?: boolean | undefined;
    ocrServerUrl?: string | undefined;
    ocrServerHeaders?: Map<string, string> | undefined;
    tessdataPath?: string | undefined;
    maxPages?: number | undefined;
    targetPages?: string | undefined;
    dpi?: number | undefined;
    outputFormat?: "json" | "text" | "markdown" | "md";
    imageMode?: "off" | "none" | "placeholder" | "embed";
    extractImages?: boolean | undefined;
    extractLinks?: boolean | undefined;
    /**
     * Keep running headers/footers in markdown output instead of stripping
     * repeated page-band lines and page chrome. Default false.
     */
    keepHeadersFooters?: boolean | undefined;
    extractAnnotations?: boolean | undefined;
    extractFormFields?: boolean | undefined;
    extractStructureTree?: boolean | undefined;
    /**
     * Extract raw XFA packets (name + XML content) into
     * `ParseResult.xfaPackets`. Default false.
     */
    extractXfaPackets?: boolean | undefined;
    /**
     * Collect document provenance metadata into `ParseResult.docMeta`.
     * Default false: it streams the whole source file once.
     */
    extractDocumentMetadata?: boolean | undefined;
    /**
     * Emit each page\'s `contentBounds` (union bbox of top-level content
     * objects, viewport coords). Default false.
     */
    extractContentBounds?: boolean | undefined;
    ocrFailureFatal?: boolean | undefined;
    ocrHedgeDelaysMs?: number[] | undefined;
    preserveVerySmallText?: boolean | undefined;
    password?: string | undefined;
    quiet?: boolean | undefined;
    emitWordBoxes?: boolean | undefined;
    /**
     * Restrict output to a page sub-region. Each field is the fraction of the
     * page cropped from that side; a text item survives only if it lies
     * entirely inside the remaining rectangle. Unset keeps the whole page.
     */
    cropBox?: CropBox | undefined;
    /**
     * Drop diagonal text (rotation >2° off the nearest right angle). Default
     * false. Use to exclude rotated watermarks/stamps from the output.
     */
    skipDiagonalText?: boolean | undefined;
    /**
     * Compute per-page complexity signals during parse and attach them to each
     * page as `ParsedPage.complexity` (the same signals `isComplex` returns).
     * Default false; enabling it runs an extra vector-text detection pass.
     */
    includeComplexity?: boolean | undefined;
    /**
     * Expose page-scoped vector shapes and merged H/V line segments.
     */
    extractVectorGraphics?: boolean | undefined;
    /**
     * Include rich PDF text metadata on text items (font metrics/weight,
     * buggy state, MCID, fill/stroke colors, raw char codes, generated
     * trailing-space state). Default false.
     */
    extractTextMetadata?: boolean | undefined;
    /**
     * Draw AcroForm field appearances into OCR rasters (runs document
     * open/JS actions). Default false.
     */
    renderFormFields?: boolean | undefined;
}

export interface OcrResult {
    text: string;
    bbox: [number, number, number, number];
    confidence: number;
    polygon?: [[number, number], [number, number], [number, number], [number, number]] | undefined;
}

export interface PageComplexityStats {
    pageNumber: number;
    textLength: number;
    textCoverage: number;
    hasSubstantialImages: boolean;
    /**
     * Number of counted raster images — inline figures only; full-page
     * backgrounds are excluded (see `fullPageImage`).
     */
    imageBlockCount: number;
    /**
     * Summed image-bbox area over page area, clamped to 1. Counts inline
     * figures only: a full-page scan raster contributes 0 here — check
     * `fullPageImage` for that.
     */
    imageCoverage: number;
    /**
     * Largest single counted image\'s area over page area, clamped to 1. Same
     * exclusion as `imageCoverage`: a full-page raster contributes 0.
     */
    largestImageCoverage: number;
    /**
     * A single raster covering ≥90% of the page is present. Such full-page
     * backgrounds are excluded from `imageCoverage`/`largestImageCoverage`
     * (they\'re not inline figures), so this flag is the only signal that
     * distinguishes a scan from a genuinely blank page — both otherwise
     * report no text and no counted images.
     */
    fullPageImage: boolean;
    uncoveredVectorArea: number | undefined;
    isGarbled: boolean;
    pageArea: number;
    needsOcr: boolean;
    reasons: string[];
    layout: LayoutComplexityStats | undefined;
}

export interface ParseResult {
    pages: ParsedPage[];
    text: string;
    images: ExtractedImage[];
    imageErrorCount: number;
    formType?: number;
    /**
     * The document\'s `/Info` `Creator` entry, when present.
     */
    creator?: string;
    /**
     * The document\'s `/Info` `Producer` entry, when present.
     */
    producer?: string;
    /**
     * Document-level provenance metadata; present only when
     * `extractDocumentMetadata` is enabled and the input was a real PDF.
     */
    docMeta?: DocumentMetadata;
    /**
     * Raw XFA packets; present only when `extractXfaPackets` is enabled.
     */
    xfaPackets?: XfaPacket[];
}

export interface ParsedPage {
    pageNum: number;
    width: number;
    height: number;
    /**
     * Union bbox of the page\'s top-level content objects in viewport
     * coords (visible content extent). Absent for empty pages.
     */
    contentBounds?: VectorRect;
    text: string;
    markdown: string;
    textItems: TextItem[];
    complexity?: PageComplexityStats;
    vectorGraphics?: VectorGraphics;
    annotations?: DocumentAnnotation[];
    formFields?: FormField[];
    structureTree?: StructureTree;
}

export interface SearchOptions {
    phrase?: string;
    caseSensitive?: boolean;
}

export interface SearchTextItem {
    text: string;
    x: number;
    y: number;
    width: number;
    height: number;
    fontName?: string | undefined;
    fontSize?: number | undefined;
    confidence?: number | undefined;
}

export interface StructureTree {
    roots: StructureTreeElement[];
}

export interface StructureTreeElement {
    type: string;
    id?: string;
    actualText?: string;
    altText?: string;
    title?: string;
    attributes: Map<string, StructureAttributeValue>;
    markedContentIds: number[];
    children: StructureTreeElement[];
    annotations: DocumentAnnotation[];
}

export interface TextItem {
    text: string;
    x: number;
    y: number;
    width: number;
    height: number;
    fontName?: string;
    fontSize?: number;
    confidence?: number;
    /**
     * Rotation in degrees (viewport space).
     */
    rotation: number;
    fontHeight?: number;
    fontAscent?: number;
    fontDescent?: number;
    fontWeight?: number;
    textWidth?: number;
    fontIsBuggy?: boolean;
    mcid?: number;
    fillColor?: string;
    strokeColor?: string;
    charCodes?: number[];
    trailingSpaceGenerated?: boolean;
    /**
     * Per-word sub-boxes for attribution. Omitted when empty (the default —
     * only populated when parsing with `emitWordBoxes: true`).
     */
    words?: WordBox[];
}

export interface VectorGraphics {
    shapes: VectorShape[];
    lines: VectorLine[];
}

export interface VectorLine {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    stroke: boolean;
    strokeWidth: number | undefined;
    strokeColor: string | undefined;
    fill: boolean;
    fillColor: string | undefined;
}

export interface VectorRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface VectorShape {
    bbox: VectorRect;
    stroke: boolean;
    strokeColor: string | undefined;
    fill: boolean;
    fillColor: string | undefined;
    hasCurve: boolean;
}

export interface WordBox {
    text: string;
    x: number;
    y: number;
    width: number;
    height: number;
}


/**
 * Chroma subsampling format
 */
export enum ChromaSampling {
    /**
     * Both vertically and horizontally subsampled.
     */
    Cs420 = 0,
    /**
     * Horizontally subsampled.
     */
    Cs422 = 1,
    /**
     * Not subsampled.
     */
    Cs444 = 2,
    /**
     * Monochrome.
     */
    Cs400 = 3,
}

export class LiteParse {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Determine per-page complexity for the given PDF bytes. Returns
     * `Promise<PageComplexityStats[]>` — a cheap pre-OCR check with per-page
     * signals and a `needsOcr` verdict.
     */
    isComplex(data: Uint8Array): Promise<PageComplexityStats[]>;
    /**
     * Construct a new parser. `config` is a JS object (all fields optional).
     * If `config.ocrEngine` is present, it is wired up as the OCR backend.
     */
    constructor(config: LiteParseInit);
    /**
     * Parse PDF bytes. Returns `Promise<ParseResult>`.
     */
    parse(data: Uint8Array): Promise<ParseResult>;
    /**
     * Return the resolved config (camelCase JS object).
     */
    readonly config: LiteParseConfig;
}

export function __wasm_start(): void;

/**
 * Search text items for phrase matches, returning merged items with combined bounding boxes.
 */
export function searchItems(items: SearchTextItem[], options: SearchOptions): TextItem[];

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_liteparse_free: (a: number, b: number) => void;
    readonly liteparse_config: (a: number) => any;
    readonly liteparse_isComplex: (a: number, b: number, c: number) => any;
    readonly liteparse_new: (a: any) => [number, number, number];
    readonly liteparse_parse: (a: number, b: number, c: number) => any;
    readonly searchItems: (a: number, b: number, c: any) => [number, number];
    readonly __wasm_start: () => void;
    readonly getpid: () => number;
    readonly pthread_mutex_destroy: (a: number) => number;
    readonly pthread_mutex_init: (a: number, b: number) => number;
    readonly pthread_mutex_lock: (a: number) => number;
    readonly pthread_mutex_unlock: (a: number) => number;
    readonly wasm_bindgen__convert__closures_____invoke__h1756cbc8a36b40d5: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen__convert__closures_____invoke__h1655e67004fe63d3: (a: number, b: number, c: any, d: any) => void;
    readonly __wbindgen_export: WebAssembly.Table;
    readonly __wbindgen_malloc_command_export: (a: number, b: number) => number;
    readonly __wbindgen_realloc_command_export: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_free_command_export: (a: number, b: number, c: number) => void;
    readonly __externref_table_alloc_command_export: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_destroy_closure_command_export: (a: number, b: number) => void;
    readonly __externref_drop_slice_command_export: (a: number, b: number) => void;
    readonly __externref_table_dealloc_command_export: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
