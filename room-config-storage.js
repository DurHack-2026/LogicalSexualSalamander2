(function (global) {
'use strict';

var STORAGE_KEY = 'roomfit.room-config.v1';

global.RoomfitRoomStorage = {
    read: function () {
        var value = global.localStorage.getItem(STORAGE_KEY);
        return value === null ? null : JSON.parse(value);
    },
    write: function (value) {
        global.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    }
};
}(window));
