// 첫 실행 시 화면 구성을 확인할 수 있도록 넣는 "가상" 샘플 데이터 (상단 [샘플 삭제]로 제거).
import { sampleDeals } from '../public/lib/samples.js';

export function seedSamples(store, today) {
  const list = sampleDeals(today);
  for (const d of list) store.insertDeal(d, { is_sample: 1 });
  return list.length;
}
