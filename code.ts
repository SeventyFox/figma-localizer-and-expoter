type Settings = {
    serializedDictionary: string;
    serializedExceptions: string;
    sourceLanguage: string;
    targetLanguage: string;
};

type Dictionary = {
    header: string[];
    rows: string[][];
};

type Mapping = {
    [source: string]: string;
};

type Style = {
    id: string;
    fills: Paint[];
    fillStyleId: string;
    fontName: FontName;
    fontSize: number;
    letterSpacing: LetterSpacing;
    lineHeight: LineHeight;
    textDecoration: TextDecoration;
    textStyleId: string;
};

type Section = {
    from: number;
    to: number;
    style: Style;
};

type Replacement = null | {
    node: TextNode;
    translation: string;
    baseStyle: Style;
    sections: Section[];
};

type ReplacementFailure = {
    node: TextNode;
    error: string;
    log: string[];
};

type ReplacementAttempt = Replacement | ReplacementFailure;


namespace SettingsManager {
    const DEFAULT: Settings = {
        serializedDictionary: 'RU\tEN\nПривет!\tHello!',
        serializedExceptions: 'Joom',
        sourceLanguage: 'RU',
        targetLanguage: 'EN',
    };
    const FIELDS = Object.keys(DEFAULT);
    const CLIENT_STORAGE_PREFIX = 'StaticLocalizer.';

    export async function load(): Promise<Settings> {
        const result = <Settings> {};
        const promises = FIELDS.map(field => figma.clientStorage.getAsync(CLIENT_STORAGE_PREFIX + field).then(value => ({field, value: value === undefined ? DEFAULT[field] : value})));
        (await Promise.all(promises)).forEach(({field, value}) => {
            result[field] = value;
        });
        return result;
    }

    export async function save(settings: Settings): Promise<void> {
        await Promise.all(FIELDS.map(field => figma.clientStorage.setAsync(CLIENT_STORAGE_PREFIX + field, settings[field])));
    }
};


async function translateSelection(settings: Settings): Promise<void> {
    const dictionary = await parseDictionary(settings.serializedDictionary);
    const mapping = await getMapping(dictionary, settings.sourceLanguage, settings.targetLanguage);
    const exceptions = await parseExceptions(settings.serializedExceptions);
    await replaceAllTexts(mapping, exceptions);
}

async function parseDictionary(serializedDictionary: string): Promise<Dictionary> {
    const table = escape(serializedDictionary).split('%0A').map(line => line.split('%09').map(field => unescape(field.trim())));
    if (table.length < 2) {
        throw {error: 'empty dictionary'};
    }
    const header = table[0];
    const expectedColumnCount = header.length;
    const rows = table.slice(1, table.length);
    console.log('Dictionary:', {header, rows});
    rows.forEach((row, index) => {
        if (row.length != expectedColumnCount) {
            throw {error: 'row ' + (index + 2) + ' of the dictionary has ' + row.length + ' (not ' + expectedColumnCount + ') columns'};
        }
    });
    return {header, rows};
}

async function getMapping(dictionary: Dictionary, sourceLanguage: string, targetLanguage: string): Promise<Mapping> {
    const sourceColumnIndex = dictionary.header.indexOf(sourceLanguage);
    if (sourceColumnIndex == -1) {
        throw {error: sourceLanguage + ' not listed in [' + dictionary.header + ']'};
    }
    const targetColumnIndex = dictionary.header.indexOf(targetLanguage);
    if (targetColumnIndex == -1) {
        throw {error: targetLanguage + ' not listed in [' + dictionary.header + ']'};
    }
    const result: Mapping = {};
    dictionary.rows.forEach(row => {
        const sourceString = row[sourceColumnIndex];
        const targetString = row[targetColumnIndex];
        if (targetString.trim() !== '') {
            result[sourceString] = targetString;
        }
    });
    console.log('Extracted mapping:', result);
    return result;
}

async function parseExceptions(serializedExceptions: string): Promise<RegExp[]> {
    return serializedExceptions.split('\n').filter(pattern => pattern !== '').map(pattern => {
        try {
            return new RegExp(pattern);
        } catch (_) {
            throw {error: 'invalid regular expression `' + pattern + '`'};
        }
    });
}

async function replaceAllTexts(mapping: Mapping, exceptions: RegExp[]): Promise<void> {
    const textNodes = await findSelectedTextNodes();

    const replacements = await Promise.all(textNodes.map(node => computeReplacement(node, mapping, exceptions)));
    const failures = replacements.filter(r => r !== null && 'error' in r) as ReplacementFailure[];
    if (failures.length > 0) {
        console.log('Failures:', failures);
        throw {error: 'found some untranslatable nodes', log: prepareLog(failures)};
    }

    await Promise.all(replacements.filter(r => r !== null).map(replaceText));
}

async function findSelectedTextNodes(): Promise<TextNode[]> {
    const result: TextNode[] = [];
    figma.currentPage.selection.forEach(root => {
        if (root.type === 'TEXT') {
            result.push(root as TextNode);
        } else if ('findAll' in root) {
            (root as ChildrenMixin).findAll(node => node.type === 'TEXT').forEach(node => result.push(node as TextNode));
        }
    });
    return result;
}

async function computeReplacement(node: TextNode, mapping: Mapping, exceptions: RegExp[]): Promise<ReplacementAttempt> {
    const content = normalizeContent(node.characters);
    if (keepAsIs(content, exceptions)) {
        return null;
    }

    if (!(content in mapping)) {
        return {node, error: 'no translation', log: [content]};
    }

    const log = [];

    log.push('Computing replacement for `' + content + '`');

    const sections = sliceIntoSections(node);
    log.push('Sections: ' + sections.map(({from, to}) => from + '-' + to).join(', '));

    const styles = [];
    const styleIds = new Set<string>();
    sections.forEach(({from, to, style}) => {
        if (!styleIds.has(style.id)) {
            styleIds.add(style.id);
            styles.push({humanId: from + '-' + to, ...style});
        }
    });

    const result: Replacement = {
        node,
        translation: mapping[content],
        baseStyle: null,
        sections: [],
    };

    for (let baseStyleCandidate of styles) {
        log.push('Base style candidate: ' + baseStyleCandidate.humanId);
        let ok = true;
        result.sections.length = 0;
        for (let {from, to, style} of sections) {
            if (style.id === baseStyleCandidate.id) {
                log.push('Section `' + node.characters.slice(from, to) + '` has the base style: ignored');
                continue;
            }
            const sectionContent = normalizeContent(node.characters.slice(from, to));
            log.push('Section `' + sectionContent + '` has a non-base style: needs translation');
            let sectionTranslation = sectionContent;
            if (sectionContent in mapping) {
                sectionTranslation = mapping[sectionContent];
            } else if (!keepAsIs(sectionContent, exceptions)) {
                log.push('No translation found: skipping the candidate');
                ok = false;
                break;
            }
            const index = result.translation.indexOf(sectionTranslation);
            if (index == -1) {
                log.push('Cannot find `' + sectionTranslation + '` within `' + result.translation + '`: skipping the candidate');
                ok = false;
                break;
            }
            if (result.translation.indexOf(sectionTranslation, index + 1) != -1) {
                log.push('Found multiple occurrencies of `' + sectionTranslation + '` within `' + result.translation + '`: skipping the candidate');
                ok = false;
                break;
            }
            log.push('Section translated');
            result.sections.push({from: index, to: index + sectionTranslation.length, style});
        }
        if (ok) {
            result.baseStyle = baseStyleCandidate;
            break;
        }
    }
    if (result.baseStyle === null) {
        return {node, error: 'cannot determine a base style', log};
    }

    console.log('Replacement:', result);

    return result;
}

function normalizeContent(content: string): string {
    return content.replace(/[\u000A\u2028\u202F\u00A0]/g, ' ').replace(/ +/g, ' ');
}

function keepAsIs(content: string, exceptions: RegExp[]): boolean {
    for (let regex of exceptions) {
        if (content.match(regex)) {
            return true;
        }
    }
    return false;
};

function sliceIntoSections(node: TextNode, from: number = 0, to: number = node.characters.length): Section[] {
    const style = getSectionStyle(node, from, to);
    if (style !== figma.mixed) {
        return [{from, to, style}];
    }

    const center = Math.floor((from + to) / 2);
    const leftSections = sliceIntoSections(node, from, center);
    const rightSections = sliceIntoSections(node, center, to);
    const lastLeftSection = leftSections[leftSections.length-1];
    const firstRightSection = rightSections[0];
    if (lastLeftSection.style.id === firstRightSection.style.id) {
        firstRightSection.from = lastLeftSection.from;
        leftSections.pop();
    }
    return leftSections.concat(rightSections);
}

function prepareLog(failures: ReplacementFailure[]): string {
    return failures.map(({node, error, log}) => (
        '<a href="javascript:focusNode(\'' + node.id + '\');">' + node.id + '</a><br/>' +
        error + '<br/>' +
        '<pre>' + log.join('\n') + '</pre>'
    )).join('<br/>');
}

async function replaceText(replacement: Replacement): Promise<void> {
    const {node, translation, baseStyle, sections} = replacement;
    await figma.loadFontAsync(baseStyle.fontName);
    await Promise.all(sections.map(({style}) => figma.loadFontAsync(style.fontName)));
    node.characters = translation;
    if (sections.length > 0) {
        setSectionStyle(node, 0, translation.length, baseStyle);
        for (let {from, to, style} of sections) {
            setSectionStyle(node, from, to, style);
        }
    }
}

function getSectionStyle(node: TextNode, from: number, to: number): Style | PluginAPI['mixed'] {
    const fills = node.getRangeFills(from, to);
    if (fills === figma.mixed) {
        return figma.mixed;
    }
    const fillStyleId = node.getRangeFillStyleId(from, to);
    if (fillStyleId === figma.mixed) {
        return figma.mixed;
    }
    const fontName = node.getRangeFontName(from, to);
    if (fontName === figma.mixed) {
        return figma.mixed;
    }
    const fontSize = node.getRangeFontSize(from, to);
    if (fontSize === figma.mixed) {
        return figma.mixed;
    }
    const letterSpacing = node.getRangeLetterSpacing(from, to);
    if (letterSpacing === figma.mixed) {
        return figma.mixed;
    }
    const lineHeight = node.getRangeLineHeight(from, to);
    if (lineHeight === figma.mixed) {
        return figma.mixed;
    }
    const textDecoration = node.getRangeTextDecoration(from, to);
    if (textDecoration === figma.mixed) {
        return figma.mixed;
    }
    const textStyleId = node.getRangeTextStyleId(from, to);
    if (textStyleId === figma.mixed) {
        return figma.mixed;
    }
    const parameters = {
        fills,
        fillStyleId,
        fontName,
        fontSize,
        letterSpacing,
        lineHeight,
        textDecoration,
        textStyleId,
    };
    return {
        id: JSON.stringify(parameters),
        ...parameters,
    };
}

function setSectionStyle(node: TextNode, from: number, to: number, style: Style): void {
    node.setRangeFills(from, to, style.fills);
    node.setRangeFillStyleId(from, to, style.fillStyleId);
    node.setRangeFontName(from, to, style.fontName);
    node.setRangeFontSize(from, to, style.fontSize);
    node.setRangeLetterSpacing(from, to, style.letterSpacing);
    node.setRangeLineHeight(from, to, style.lineHeight);
    node.setRangeTextDecoration(from, to, style.textDecoration);
    node.setRangeTextStyleId(from, to, style.textStyleId);
}


figma.showUI(__html__, {width: 500, height: 400});

figma.ui.onmessage = async message => {
    if (message.type === 'load-settings') {
        const settings = await SettingsManager.load();
        console.log('Loaded settings:', settings);
        figma.ui.postMessage({type: 'settings', settings});
    } else if (message.type === 'translate-selection') {
        await SettingsManager.save(message.settings);
        await translateSelection(message.settings)
            .then(() => {
                figma.notify('Done');
                figma.closePlugin();
            })
            .catch(reason => {
                if ('error' in reason) {
                    figma.notify('Localization failed: ' + reason.error);
                    if ('log' in reason) {
                        figma.ui.postMessage({type: 'log', log: reason.log});
                    }
                } else {
                    figma.notify(reason.toString());
                }
            })
    } else if (message.type === 'focus-node') {
        figma.viewport.zoom = 1000.0;
        figma.viewport.scrollAndZoomIntoView([figma.getNodeById(message.id)]);
        figma.viewport.zoom = 0.75 * figma.viewport.zoom;
    }
};
