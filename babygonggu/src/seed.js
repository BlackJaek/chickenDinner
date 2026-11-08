// 첫 실행 시 화면 구성을 확인할 수 있도록 넣는 "가상" 샘플 데이터.
// 계정·제품은 모두 실존하지 않는 예시이며, 화면 상단의 [샘플 삭제] 버튼으로 지울 수 있다.
// 날짜는 실행 당일 기준 상대값이라 언제 실행해도 진행중/예정/종료가 섞여 보인다.
import { addDays } from '../public/lib/dates.js';

const SAMPLES = [
  // 같은 제품을 여러 인플루언서가 릴레이로 진행하는 예시
  { handle: 'sample_mom_haru', brand: '예시브랜드A', product_name: '한우 큐브 이유식 (중기)', category: '이유식·간식', s: -12, e: -8, price: 31900, original_price: 39000 },
  { handle: 'sample_dayoung_mom', brand: '예시브랜드A', product_name: '한우 큐브 이유식 (중기)', category: '이유식·간식', s: -2, e: 2, price: 29900, original_price: 39000, note: '첫 구매 시 큐브 2팩 추가 증정' },
  { handle: 'sample_twins_daddy', brand: '예시브랜드A', product_name: '한우 큐브 이유식 (중기)', category: '이유식·간식', s: 5, e: 9, price: 29900, original_price: 39000 },

  { handle: 'sample_mom_haru', brand: '예시브랜드B', product_name: '무향 수딩 베이비 로션 500ml', category: '스킨케어·위생', s: -1, e: 4, price: 18900, original_price: 26000 },
  { handle: 'sample_seoul_babylog', brand: '예시브랜드B', product_name: '무향 수딩 베이비 로션 500ml', category: '스킨케어·위생', s: 8, e: 12, price: 18500, original_price: 26000 },

  { handle: 'sample_seoul_babylog', brand: '예시브랜드C', product_name: '밤부 팬티형 기저귀 4단계', category: '기저귀·물티슈', s: -4, e: 0, price: 45900, original_price: 58000, note: '오늘 자정 마감' },
  { handle: 'sample_jeju_ddalgi', brand: '예시브랜드C', product_name: '밤부 팬티형 기저귀 4단계', category: '기저귀·물티슈', s: 3, e: 7, price: 44900, original_price: 58000 },

  { handle: 'sample_jeju_ddalgi', brand: '예시브랜드D', product_name: '실리콘 빨대컵 세트', category: '수유·식기', s: -3, e: 3, price: 15900, original_price: 22000 },
  { handle: 'sample_twins_daddy', brand: '예시브랜드E', product_name: '원목 소근육 교구 세트', category: '장난감·도서', s: 1, e: 6, price: 52000, original_price: 69000 },
  { handle: 'sample_dayoung_mom', brand: '예시브랜드F', product_name: '유기농 쌀떡뻥 6종', category: '이유식·간식', s: 10, e: null, price: 12900, note: '재고 소진 시 마감' },
  { handle: 'sample_mom_haru', brand: '예시브랜드G', product_name: '경량 휴대용 유모차', category: '외출·이동', s: -20, e: -15, price: 289000, original_price: 359000 },
  { handle: 'sample_seoul_babylog', brand: '예시브랜드H', product_name: '거즈 수면조끼', category: '의류·침구', s: 0, e: 5, price: 24900, original_price: 32000 },
];

export function seedSamples(store, today) {
  for (const x of SAMPLES) {
    store.insertDeal({
      ...x,
      start_date: addDays(today, x.s),
      end_date: x.e == null ? null : addDays(today, x.e),
    }, { is_sample: 1 });
  }
  return SAMPLES.length;
}
