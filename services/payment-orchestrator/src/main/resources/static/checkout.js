/*!
 * AI Payment Gateway - checkout.js
 *
 * Drop-in hosted checkout, modelled on Razorpay Checkout:
 *
 *   <script src="http://localhost:8080/checkout.js"></script>
 *   <script>
 *     var checkout = new GatewayCheckout({
 *       key: "key_test_XXXXXXXXXXXXXX",   // public key id - never the key secret
 *       order_id: "order_XXXXXXXXXXXXXX", // created by your server: POST /v1/orders
 *       name: "Acme Store",
 *       description: "Order #1234",
 *       prefill: { email: "ravi@example.com", contact: "9876543210", vpa: "success@gateway" },
 *       theme: { color: "#2563eb" },
 *       handler: function (response) {
 *         // response.payment_id, response.order_id, response.signature
 *         // Send these to your server and verify the signature before fulfilling the order.
 *       },
 *       modal: { ondismiss: function () { console.log("Checkout closed"); } }
 *     });
 *     checkout.on("payment.failed", function (response) { console.log(response.error); });
 *     checkout.open();
 *   </script>
 */
(function (window, document) {
  "use strict";

  var script = document.currentScript;
  var GATEWAY_ORIGIN = script && script.src ? new URL(script.src, window.location.href).origin : window.location.origin;
  var MESSAGE_SOURCE = "gateway-checkout";

  function GatewayCheckout(options) {
    if (!(this instanceof GatewayCheckout)) {
      return new GatewayCheckout(options);
    }
    if (!options || !options.key) {
      throw new Error("GatewayCheckout: options.key (your public key_id) is required");
    }
    if (!options.order_id) {
      throw new Error("GatewayCheckout: options.order_id is required");
    }
    this.options = options;
    this.listeners = {};
    this.frame = null;
    this.previousOverflow = "";
    this.onMessage = this.onMessage.bind(this);
  }

  GatewayCheckout.prototype.on = function (event, callback) {
    (this.listeners[event] = this.listeners[event] || []).push(callback);
    return this;
  };

  GatewayCheckout.prototype.emit = function (event, payload) {
    (this.listeners[event] || []).forEach(function (callback) {
      try {
        callback(payload);
      } catch (e) {
        window.console && console.error(e);
      }
    });
  };

  GatewayCheckout.prototype.open = function () {
    if (this.frame) {
      return this;
    }
    var options = this.options;
    var prefill = options.prefill || {};
    var theme = options.theme || {};
    var params = new URLSearchParams({
      key_id: options.key,
      order_id: options.order_id,
      origin: window.location.origin,
      name: options.name || "",
      description: options.description || "",
      email: prefill.email || "",
      contact: prefill.contact || "",
      vpa: prefill.vpa || "",
      method: prefill.method || "",
      color: theme.color || ""
    });

    // The frame covers the viewport and draws its own backdrop and dialog.
    var frame = document.createElement("iframe");
    frame.src = GATEWAY_ORIGIN + "/checkout/frame.html?" + params.toString();
    frame.title = "Secure checkout";
    frame.setAttribute("allow", "payment");
    frame.setAttribute("style", "position:fixed;inset:0;width:100%;height:100%;border:0;margin:0;padding:0;" +
      "z-index:2147483647;background:transparent;color-scheme:normal;");
    frame.setAttribute("allowtransparency", "true");

    window.addEventListener("message", this.onMessage);
    this.previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.body.appendChild(frame);
    this.frame = frame;
    frame.focus();
    return this;
  };

  GatewayCheckout.prototype.close = function () {
    if (!this.frame) {
      return this;
    }
    window.removeEventListener("message", this.onMessage);
    this.frame.parentNode && this.frame.parentNode.removeChild(this.frame);
    this.frame = null;
    document.body.style.overflow = this.previousOverflow;
    return this;
  };

  GatewayCheckout.prototype.onMessage = function (event) {
    // Only trust messages from our own checkout frame.
    if (event.origin !== GATEWAY_ORIGIN || !this.frame || event.source !== this.frame.contentWindow) {
      return;
    }
    var message = event.data || {};
    if (message.source !== MESSAGE_SOURCE) {
      return;
    }
    var options = this.options;
    switch (message.type) {
      case "payment.success":
        this.close();
        if (typeof options.handler === "function") {
          options.handler(message.payload);
        }
        break;
      case "payment.failed":
        this.emit("payment.failed", message.payload);
        break;
      case "dismiss":
        this.close();
        if (options.modal && typeof options.modal.ondismiss === "function") {
          options.modal.ondismiss();
        }
        break;
    }
  };

  window.GatewayCheckout = GatewayCheckout;
})(window, document);
