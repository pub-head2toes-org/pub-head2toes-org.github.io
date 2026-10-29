function getOperation(cb,ctx){
    let getPath = ctx.reqPath;

    $.ajax({
        url : getPath,
        type : "get"
        }).done(function(data) {
        console.log("state data=" + JSON.stringify(data));
        ctx.data = data;
        cb(ctx);
        }).fail(function(error) {
        var err = JSON.stringify(error);
        ctx.errDesc = "getOperation";
        ctx.error = error;
        cb(ctx);
        document.getElementById("getData").value = "" + err;
        console.log("get state failed: err=" + err);
        }); 
  }

  // onError is optional: it hears about a request that never got an answer.
  function insertOperation(cb,ctx,onError){
    let reqPath = ctx.reqPath;
    let reqInput = ctx.payload;
    const hdrs = new Headers({
	    contentType: "application/json"
    });
    // ctx.keepalive: the request outlives a navigation that starts meanwhile.
    const fetchData = {
	    method: 'POST',
	    mode: 'cors',
	    body: reqInput,
	    headers: hdrs,
	    keepalive: !!ctx.keepalive
    }
    fetch(reqPath, fetchData).then(function(data) {
        ctx.insertResponse = data;
        console.log("state data=" + JSON.stringify(data));
        cb(ctx);

        }).catch(function(error) {
        var err = JSON.stringify(error);
        console.log("insert failed: err=" + err);
        if (onError) {
          onError(error, ctx);
        }
        }); 
  }

  function updateOperation(cb, ctx){
    let getPath = ctx.reqPath;
    let reqInput = ctx.payload;
    $.ajax({
        url : getPath,
        type : "PUT",
        data : reqInput,
        dataType : "json",
        contentType: "application/json"
        }).done(function(data) {

        console.log("state data=" + JSON.stringify(data));
        cb(ctx);

        }).fail(function(error) {
        var err = JSON.stringify(error);
        console.log("insert failed: err=" + err);
        }); 
  }
