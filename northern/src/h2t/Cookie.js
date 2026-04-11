'use strict';

export default class Cookie {
    getCookie(cookie, cname) {
        try{
            if (!cookie){
                return "";
            }
            var name = cname + "=";
            var ca = cookie.split(';');
            for(var i = 0; i < ca.length; i++) {
                var c = ca[i];
                while (c.charAt(0) == ' ') {
                    c = c.substring(1);
                }
                if (c.indexOf(name) == 0) {
                    return c.substring(name.length, c.length);
                }
            }
            return "";
        } catch (e){
            console.log(e);
        }
    }
}
