// 카카오맵 JS SDK 최소 타입 선언 — 이 앱이 실제로 쓰는 것만 적는다.
declare global {
  interface Window {
    kakao: typeof kakao;
  }

  namespace kakao.maps {
    function load(callback: () => void): void;

    class LatLng {
      constructor(lat: number, lng: number);
      getLat(): number;
      getLng(): number;
    }

    class LatLngBounds {
      constructor();
      extend(latlng: LatLng): void;
    }

    class Map {
      constructor(container: HTMLElement, options: { center: LatLng; level: number });
      setCenter(latlng: LatLng): void;
      getCenter(): LatLng;
      setLevel(level: number): void;
      getLevel(): number;
      panTo(latlng: LatLng): void;
      /** 패딩(px)을 주면 궤적이 화면 가장자리·패널에 가리지 않는다: top, right, bottom, left */
      setBounds(
        bounds: LatLngBounds,
        paddingTop?: number,
        paddingRight?: number,
        paddingBottom?: number,
        paddingLeft?: number
      ): void;
      setMapTypeId(mapTypeId: MapTypeId): void;
      addOverlayMapTypeId(mapTypeId: MapTypeId): void;
      removeOverlayMapTypeId(mapTypeId: MapTypeId): void;
      relayout(): void;
    }

    /** ROADMAP=일반, SKYVIEW=위성, HYBRID=위성 위에 얹는 도로·지명 오버레이 */
    type MapTypeId = number & { readonly __kakaoMapTypeId: unique symbol };
    const MapTypeId: {
      ROADMAP: MapTypeId;
      SKYVIEW: MapTypeId;
      HYBRID: MapTypeId;
    };

    class Polyline {
      constructor(options: {
        map?: Map;
        path: LatLng[];
        strokeWeight?: number;
        strokeColor?: string;
        strokeOpacity?: number;
        strokeStyle?: string;
        zIndex?: number;
      });
      setMap(map: Map | null): void;
      getLength(): number;
    }

    class CustomOverlay {
      constructor(options: {
        position: LatLng;
        content: string | HTMLElement;
        map?: Map;
        yAnchor?: number;
        xAnchor?: number;
        zIndex?: number;
      });
      setMap(map: Map | null): void;
      setPosition(latlng: LatLng): void;
    }

    namespace event {
      function addListener(
        target: object,
        type: string,
        handler: (...args: unknown[]) => void
      ): void;
    }
  }
}

export {};
