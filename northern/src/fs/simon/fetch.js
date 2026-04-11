function get(url){
    fetch(url).then(function(response) {
        response.text().then(function (text) {
            return text;
        });
    }).catch(function(error) {
        console.log('Looks like there was a problem: \n', error);
        return undefined;
    });
}

function post(url, data, headers){
    doMethod(url, 'POST', data, headers);
}

function put(url, data, headers){
    doMethod(url, 'PUT', data, headers);
}

function doMethod(url, httpMethod, data, headers){
let hdrs = new Headers(headers);
let fetchData = { 
    method: httpMethod, 
    body: data,
    headers: hdrs
}
    fetch(url, fetchData).then(function(response) {
        response.text().then(function (text) {
            return text;
        });
    }).catch(function(error) {
        console.log('Looks like there was a problem: \n', error);
        return undefined;
    });
}
