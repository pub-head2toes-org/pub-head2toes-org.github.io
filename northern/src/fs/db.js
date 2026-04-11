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

  function insertOperation(cb,ctx){
    let reqPath = ctx.reqPath;
    let reqInput = ctx.payload;
    $.ajax({
        url : reqPath,
        type : "post",
        data : reqInput,
        dataType : "json",
        contentType: "application/json"
        }).done(function(data) {
        ctx.insertResponse = data;
        console.log("state data=" + JSON.stringify(data));
        cb(ctx);

        }).fail(function(error) {
        var err = JSON.stringify(error);
        console.log("insert failed: err=" + err);
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