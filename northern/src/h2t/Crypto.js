'use strict';

import crypto from 'node:crypto'; 
import sjclClass from './sjclClass.js'
const sjcl = new sjclClass().get();

export default class Crypto {

    verifySsid (ssid){
        try {
            var ret = {};
            var arr = ssid.split(".");
            var pubB64 = arr[0];
            var msg = arr[0] + "." + arr[1];
            var sig = arr[2];
            var alg = arr.length > 3 ? arr[3] : "EC";
            ret.ssid = ssid;
            ret.pubB64 = pubB64;
            ret.sStart = arr[1];
            ret.sValid =  this.verify(pubB64, msg, sig, alg);
        return ret;
        } catch (e) {
            console.log(e);
            return false;
        }
    }

    verify (pubB64, msg, sig, alg){
        var pubKey = new sjcl.ecc.ecdsa.publicKey(
            sjcl.ecc.curves.c256,
            sjcl.codec.base64.toBits(pubB64)
        );
        if ("EC" === alg){
            return pubKey.verify(sjcl.hash.sha256.hash(msg), sjcl.codec.base64.toBits(sig));
        } else { //RSA from Win Hello
            var verify = crypto.createVerify('RSA-SHA256');
            var msg = new Buffer(body.msg,'base64');
            verify.update(msg);
            return verify.verify(pubB64, sig, 'base64');
        }
    }

}
