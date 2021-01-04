import { v4 as getV4, v6 as getV6 } from "public-ip";
import { resolve4, resolve6 } from "dns";
import { promisify } from "util";
import parse, { HTMLElement } from "node-html-parser";
import r, { CoreOptions, Response } from "request";
import { readFile } from "fs/promises";

const request = r.defaults({ jar: true, gzip: true });


interface Config {
    email: string,
    password: string,
    "update interval": number,
    domain: {
        name: string,
        ttl: number
    }
}

let currentIpv4: string;
let currentIpv6: string;

let config!: Config;
let subDomain!: string;

const defaultHeaders = {
    'Host': 'www.united-domains.de',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:84.0) Gecko/20100101 Firefox/84.0',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'de,en-US;q=0.7,en;q=0.3',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': 1,
    'TE': 'Trailers',
    'Cookie': 'welcome-layer-seen=1; CookieSettingsGroupId=5565384.2'
};

async function update() {
    const start = Date.now();

    config = await readConfig();
    subDomain = (config.domain.name.match(/^(.*?)\..+?\..*?$/) || '')[1] || '';

    if (subDomain) config.domain.name = config.domain.name.substr(subDomain.length + 1);

    console.log(config.domain.name);

    const ipV4 = await getV4();
    const domainIpV4 = currentIpv4 || await asyncResolve4(config.domain.name);

    console.log(ipV4, domainIpV4);

    const ipV6 = await getV6();
    const domainIpV6 = currentIpv6 || await asyncResolve6(config.domain.name);

    console.log(ipV6, domainIpV6);

    if ((ipV4 !== domainIpV4 || ipV6 !== domainIpV6) && !await isAuthenticated()) {
        console.log('login');

        await login();

        console.log('loggedin');
    }

    if (ipV4 !== domainIpV4) await setIPV4(ipV4);

    if (ipV6 !== domainIpV6) await setIPV6(ipV6);

    if (start + config["update interval"] > Date.now()) await asyncTimeout((start + config["update interval"]) - Date.now());

    await update();
}


async function asyncRequest(uri: string, options?: CoreOptions): Promise<Response> {
    return new Promise((resolve, reject) => {
        request(uri, options, ((error, response) => {
            if (error) reject(error);
            else resolve(response);
        }));
    });
}

async function asyncResolve4(hostname: string): Promise<string | undefined> {
    try {
        return (await promisify(resolve4)(hostname))[0];
    } catch {
        return undefined;
    }
}

async function asyncResolve6(hostname: string): Promise<string | undefined> {
    try {
        return (await promisify(resolve6)(hostname))[0];
    } catch {
        return undefined;
    }
}

function asyncTimeout(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(() => resolve(), ms));
}

async function getLoginCSRF(): Promise<string> {
    const html = <string>(await asyncRequest('https://www.united-domains.de', { headers: defaultHeaders })).body;
    const parsed = parse(html);

    const csrf = (<HTMLElement>parsed.querySelector('#login-form-1').childNodes[1]).getAttribute('value');

    if (!csrf) throw 'cant get csrf';

    return csrf;
}

async function getLanguageCSRF(): Promise<string> {
    const html = <string>(await asyncRequest('https://www.united-domains.de', { headers: defaultHeaders })).body;

    return html.match(/"CSRF_TOKEN":"(.+)","AJAX_TOKEN"/)![1];
}

async function getDomainID(fail: boolean = false): Promise<number | undefined> {
    if (fail) throw 'not authenticated';

    if (!await isAuthenticated()) {
        await login();
        return await getDomainID(true);
    }

    const json = <string>(await asyncRequest('https://www.united-domains.de/pfapi/domain-list', { headers: defaultHeaders })).body;

    return JSON.parse(json).data.find((domain: { domain: string, id: number }) => domain.domain === config.domain.name).id;
}

async function login(): Promise<void> {
    await setUserLanguage();

    const loginBody = `csrf=${await getLoginCSRF()}&selector=login&email=${encodeURIComponent(config.email)}&pwd=${config.password}&loginBtn=Login`;

    await asyncRequest('https://www.united-domains.de/login', {
        method: 'POST',
        body: loginBody,
        headers: Object.assign({
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': loginBody.length,
            'Origin': 'https://www.united-domains.de'
        }, defaultHeaders)
    });
}

async function isAuthenticated(): Promise<boolean> {
    const html = (await asyncRequest('https://www.united-domains.de/portfolio', { headers: defaultHeaders })).body;

    return !html.includes('login');
}

async function setIP(ip: string, isIpV6: boolean = false): Promise<void> {
    console.log('set ip');

    const domainID = await getDomainID();

    const body = JSON.stringify({
        'record': {
            'address': ip,
            'filter_value': '',
            'ttl': config.domain.ttl,
            'type': isIpV6 ? 'AAAA' : 'A',
            'standard_value': false,
            'sub_domain': subDomain,
            'domain': config.domain.name,
            'id': null,
            "webspace": false,
            'formId': isIpV6 ? 'AAAA0' : 'A0'
        },
        'domain_lock_state': {
            'domain_locked': false,
            'email_locked': false
        }
    });

    console.log(body);

    await asyncRequest(`https://www.united-domains.de/pfapi/dns/domain/${domainID}/records`, {
        method: 'PUT',
        body,
        headers: Object.assign({
            'Http-X-Csrf-Token': await getLanguageCSRF(),
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': body.length
        }, defaultHeaders)
    });
}

async function setIPV4(ip: string): Promise<void> {
    await setIP(ip);
    currentIpv4 = ip;

    setTimeout(() => {
        currentIpv4 = '';
    }, 600000);
}

async function setIPV6(ip: string): Promise<void> {
    await setIP(ip, true);
    currentIpv6 = ip;

    setTimeout(() => {
        currentIpv6 = '';
    }, 600000);
}

async function setUserLanguage() {
    await asyncRequest('https://www.united-domains.de/set-user-language', { method: 'POST', headers: Object.assign({ 'HTTP-X-CSRF-TOKEN': await getLanguageCSRF() }, defaultHeaders), body: 'language=de' });
}

async function readConfig(): Promise<Config> {
    return JSON.parse(await readFile('config.json', { encoding: 'utf8' }));
}

update();