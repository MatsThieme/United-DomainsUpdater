import parse, { HTMLElement } from 'node-html-parser';
import { v4, v6 } from 'public-ip';
import { CoreOptions, Response } from 'request';

import r = require('request');

const request = r.defaults({ jar: true, gzip: true });


interface Config {
    email: string,
    password: string,
    'update interval': number,
    domain: {
        name: string,
        ttl: number
    }
}

let wait: number = 0;
let busy: boolean = false;
const config: Config = require('./config.json');
const subDomain: string = (config.domain.name.match(/^(.*?)\..+?\..*?$/) || '')[1] || '';

if (subDomain) config.domain.name = config.domain.name.substr(subDomain.length + 1);

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


async function update(): Promise<void> {
    if (busy || wait > 0) {
        wait--;
        return;
    }

    busy = true;

    try {
        if (!await isAuthenticated()) {
            console.log('login');
            if (!await login()) {
                busy = false;
                wait = 5;
                console.log('could not log in');
                return;
            }
            console.log('loggedin');
        }


        const ipV4 = await v4();
        const domainIpV4 = await getCurrentIPV4(config.domain.name);


        const ipV6 = await v6();
        const domainIpV6 = await getCurrentIPV6(config.domain.name);

        if (ipV4 !== domainIpV4 || ipV6 !== domainIpV6) console.log(config.domain.name);

        if (ipV4 !== domainIpV4) {
            console.log(`set ip: current ip: ${ipV4} current domain record: ${domainIpV4}`);
            await setIPV4(config.domain.name, ipV4);
        }

        if (ipV6 !== domainIpV6) {
            console.log(`set ip: current ip: ${ipV6} current domain record: ${domainIpV6}`);
            await setIPV6(config.domain.name, ipV6);
        }
    } catch (err) {
        if (!err.code.includes('TIMEDOUT')) console.log(err);
        else wait = 5;
    }

    busy = false;
}

async function asyncRequest(uri: string, options?: CoreOptions): Promise<Response> {
    return new Promise((resolve, reject) => {
        request(uri, { ...options, timeout: config['update interval'] }, ((error, response) => {
            if (error) reject(error);
            else resolve(response);
        }));
    });
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

async function getDomainID(domain: string, fail: boolean = false): Promise<number | undefined> {
    if (fail) throw 'not authenticated';

    if (!await isAuthenticated()) {
        if (await login()) return await getDomainID(domain, true);
        else return undefined;
    }

    const json = <string>(await asyncRequest('https://www.united-domains.de/pfapi/domain-list', { headers: defaultHeaders })).body;

    return JSON.parse(json).data.find((domain: { domain: string, id: number }) => domain.domain === config.domain.name).id;
}

async function login(): Promise<boolean> {
    await setUserLanguage();

    const loginBody = `csrf=${await getLoginCSRF()}&selector=login&email=${encodeURIComponent(config.email)}&pwd=${config.password}&loginBtn=Login`;

    await asyncRequest('https://www.united-domains.de/login', {
        method: 'POST',
        body: loginBody,
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': loginBody.length,
            'Origin': 'https://www.united-domains.de',
            ...defaultHeaders
        }
    });

    return (await isAuthenticated());
}

async function isAuthenticated(): Promise<boolean> {
    const html = (await asyncRequest('https://www.united-domains.de/portfolio', { headers: defaultHeaders })).body;

    return !html.includes('login');
}

async function setIP(domain: string, ip: string, isIpV6: boolean = false): Promise<void> {
    const domainID = await getDomainID(domain);

    if (domainID === undefined) throw new Error('domainID undefined');

    const id = (isIpV6 ? await getCurrentIPV6RecordId(domain) : await getCurrentIPV4RecordId(domain)) || null;

    const body = JSON.stringify({
        'record': {
            'address': ip,
            'filter_value': config.domain.name,
            'ttl': config.domain.ttl,
            'type': isIpV6 ? 'AAAA' : 'A',
            'standard_value': false,
            'sub_domain': subDomain,
            'domain': config.domain.name,
            'id': id,
            'webspace': false,
            'formId': id
        },
        'domain_lock_state': {
            'domain_locked': false,
            'email_locked': false
        }
    });


    const res = await asyncRequest(`https://www.united-domains.de/pfapi/dns/domain/${domainID}/records`, {
        method: 'PUT',
        body,
        headers: {
            'Http-X-Csrf-Token': await getLanguageCSRF(),
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': body.length,
            ...defaultHeaders
        }
    });

    if (res.statusCode !== 200) console.log(res.statusMessage);
}

async function getDomainRecordIPV4(domain: string): Promise<{ domain: string, address: string, id: number } | undefined> {
    if (!await isAuthenticated()) return <undefined>console.error('not authenticated');

    const x: { data: { A: { domain: string, address: string, id: number }[] } } = JSON.parse((await asyncRequest(`https://www.united-domains.de/pfapi/dns/domain/${await getDomainID(domain)}/records`, { headers: defaultHeaders })).body);

    return x.data.A.find(e => e.domain === domain);
}

async function getDomainRecordIPV6(domain: string): Promise<{ domain: string, address: string, id: number } | undefined> {
    if (!await isAuthenticated()) return <undefined>console.error('not authenticated');

    const x: { data: { AAAA: { domain: string, address: string, id: number }[] } } = JSON.parse((await asyncRequest(`https://www.united-domains.de/pfapi/dns/domain/${await getDomainID(domain)}/records`, { headers: defaultHeaders })).body);

    return x.data.AAAA.find(e => e.domain === domain);
}

async function getCurrentIPV4(domain: string): Promise<string | undefined> {
    return (await getDomainRecordIPV4(domain))?.address;
}

async function getCurrentIPV6(domain: string): Promise<string | undefined> {
    return (await getDomainRecordIPV6(domain))?.address;
}

async function getCurrentIPV4RecordId(domain: string): Promise<number | undefined> {
    return (await getDomainRecordIPV4(domain))?.id;
}

async function getCurrentIPV6RecordId(domain: string): Promise<number | undefined> {
    return (await getDomainRecordIPV6(domain))?.id;
}

async function setIPV4(domain: string, ip: string): Promise<void> {
    await setIP(domain, ip);
}

async function setIPV6(domain: string, ip: string): Promise<void> {
    console.log('set ip v6');
    await setIP(domain, ip, true);
}

async function setUserLanguage() {
    await asyncRequest('https://www.united-domains.de/set-user-language', { method: 'POST', headers: { 'HTTP-X-CSRF-TOKEN': await getLanguageCSRF(), ...defaultHeaders }, body: 'language=de' });
}


setInterval(update, config['update interval']);
