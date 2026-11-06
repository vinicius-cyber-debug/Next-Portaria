import {readFileSync} from 'node:fs';
import {X509Certificate,createPrivateKey} from 'node:crypto';
import {isIP,BlockList} from 'node:net';
export function validateServerConfig(config){
 if(isIP(config.host)!==4||config.host==='0.0.0.0')throw Error('Configure o IPv4 interno da interface do servidor.');
 if(!Number.isInteger(config.port)||config.port<1024||config.port>65535||!Number.isInteger(config.uiPort)||config.uiPort<1024||config.uiPort>65535||config.uiPort===config.port)throw Error('Portas invalidas.');
 const [network,prefix,...rest]=String(config.subnet).split('/');
 if(rest.length||isIP(network)!==4||!/^\d+$/.test(prefix)||Number(prefix)<8||Number(prefix)>32)throw Error('Rede IPv4/CIDR invalida.');
 const allowed=new BlockList();allowed.addSubnet(network,Number(prefix),'ipv4');
 if(!allowed.check(config.host,'ipv4'))throw Error('O IP do servidor nao pertence a rede permitida.');
 const cert=readFileSync(config.cert),key=readFileSync(config.key),x509=new X509Certificate(cert);
 if(!x509.checkPrivateKey(createPrivateKey(key))||!x509.checkIP(config.host)||Date.parse(x509.validFrom)>Date.now()||Date.parse(x509.validTo)<=Date.now())throw Error('Certificado invalido para este IP, chave ou validade.');
 return {allowed,cert,key,origin:`https://${config.host}:${config.port}`};
}
